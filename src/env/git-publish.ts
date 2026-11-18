import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GithubRepoRef } from '../channels/github-source.ts'
import type { GhRun } from '../channels/github-source.ts'
import { runGh } from '../channels/github-source.ts'
import { UserError } from '../shared/errors.ts'
import {
  assertGitCommonDirInsideWorkspace,
  currentBranch,
  normalizePeanutBranch,
} from './git-workspace.ts'

export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

export interface GitRun {
  (args: string[], opts: { cwd: string }): Promise<GitRunResult>
}

export const runGit: GitRun = (args, opts) => new Promise((resolve, reject) => {
  const child = spawn('git', args, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    // GIT_NO_LAZY_FETCH: upload-pack in the Worker repo must never start a
    // promisor fetch driven by that repo's own remote config.
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer | string) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
  child.on('error', error => reject(new Error(`cannot run git: ${error.message}`)))
  child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
})

export interface PublishFeaturePrInput {
  workerId: string
  title: string
  body?: string
  branch?: string
}

export interface PublishFeaturePrResult {
  url: string
  number: number
  branch: string
  remote: string
}

export interface FeaturePrPublisherOptions {
  repo: GithubRepoRef
  workspace: (workerId: string) => string
  /** Test override: `git push` destination instead of the default GitHub remote URL. */
  pushRemote?: string
  git?: GitRun
  gh?: GhRun
}

/**
 * Host-side publish path for Peanut workers. Fixed repo, peanut/ prefix only,
 * PR to main — no merge, force, tags, or arbitrary gh argv from the model.
 */
export class FeaturePrPublisher {
  private readonly repo: GithubRepoRef
  private readonly workspace: (workerId: string) => string
  private readonly pushRemote: string
  private readonly git: GitRun
  private readonly gh: GhRun

  constructor(options: FeaturePrPublisherOptions) {
    this.repo = options.repo
    this.workspace = options.workspace
    this.pushRemote = options.pushRemote ?? `https://github.com/${options.repo.full}.git`
    this.git = options.git ?? runGit
    this.gh = options.gh ?? runGh
  }

  async publish(input: PublishFeaturePrInput): Promise<PublishFeaturePrResult> {
    const title = input.title?.trim()
    if (!title) throw new UserError('publish_feature_pr needs title')
    const ws = this.workspace(input.workerId)
    assertGitCommonDirInsideWorkspace(ws)
    const head = currentBranch(ws)
    const branch = normalizePeanutBranch(input.branch, head)
    // The Worker can write everything under `ws`, including `.git/hooks` and
    // `.git/config` (pushInsteadOf, fsmonitor, credential.helper, ...). Never run
    // checkout/push there: copy the Worker's HEAD commit into a host-private bare
    // repo with a plain object fetch (upload-pack runs no hooks) and push from it.
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-agent-publish-'))
    try {
      await this.stageWorkspaceHead(ws, stage, branch)
      const push = await this.git(
        ['push', this.pushRemote, `HEAD:${branch}`],
        { cwd: stage },
      )
      if (push.code !== 0) {
        throw new UserError(`git push failed (exit ${push.code}): ${push.stderr.trim().slice(0, 400)}`)
      }
    } finally {
      try {
        fs.rmSync(stage, { recursive: true, force: true })
      } catch {
        /* cleanup best-effort */
      }
    }
    const remote = `${this.repo.owner}/${this.repo.repo}`
    const { number, url } = await this.upsertPullRequest(branch, title, input.body)
    return { url, number, branch, remote }
  }

  /** Host-owned bare repo whose HEAD is `branch`, set to the Worker's HEAD commit. */
  private async stageWorkspaceHead(ws: string, stage: string, branch: string): Promise<void> {
    const init = await this.git(['init', '--bare', '--quiet', `--initial-branch=${branch}`], { cwd: stage })
    if (init.code !== 0) {
      throw new UserError(`git init failed (exit ${init.code}): ${init.stderr.trim().slice(0, 300)}`)
    }
    const fetch = await this.git(
      ['fetch', '--quiet', '--no-tags', ws, `+HEAD:refs/heads/${branch}`],
      { cwd: stage },
    )
    if (fetch.code !== 0) {
      throw new UserError(
        `publish refused: workspace has no commits to publish or is unreadable (git fetch exit ${fetch.code}): `
        + fetch.stderr.trim().slice(0, 300),
      )
    }
  }

  private async upsertPullRequest(
    headBranch: string,
    title: string,
    body?: string,
  ): Promise<{ number: number; url: string }> {
    let listOut: string
    try {
      listOut = await this.gh([
        'pr', 'list',
        '--repo', this.repo.full,
        '--head', headBranch,
        '--base', 'main',
        '--state', 'open',
        '--json', 'number,url',
        '--limit', '1',
      ])
    } catch (error) {
      throw new UserError(`gh pr list failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const items = listOut.trim() ? (JSON.parse(listOut) as { number: number; url: string }[]) : []
    if (items[0]) {
      const number = items[0].number
      const url = items[0].url
      const editArgs = ['pr', 'edit', String(number), '--repo', this.repo.full, '--title', title]
      if (body?.trim()) editArgs.push('--body', body.trim())
      await this.gh(editArgs)
      return { number, url }
    }
    const createArgs = [
      'pr', 'create',
      '--repo', this.repo.full,
      '--base', 'main',
      '--head', headBranch,
      '--title', title,
    ]
    if (body?.trim()) createArgs.push('--body', body.trim())
    let createOut: string
    try {
      createOut = await this.gh(createArgs)
    } catch (error) {
      throw new UserError(`gh pr create failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const url = createOut.trim().split(/\s+/).pop() ?? ''
    if (!url) throw new UserError('gh pr create returned no URL')
    const viewOut = await this.gh(['pr', 'view', url, '--repo', this.repo.full, '--json', 'number,url'])
    const parsed = JSON.parse(viewOut) as { number: number; url: string }
    return { number: parsed.number, url: parsed.url || url }
  }
}

