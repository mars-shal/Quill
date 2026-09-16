/** Typed REST client for the quill_engine sidecar. */

export interface WarningOut {
  code: string
  message: string
  location: string
}

export interface SourceRefOut {
  title: string
  url: string
  kind: string
}

export interface SectionNode {
  section_id: string
  title: string
  level: number
  order: number
  status: 'generated' | 'blocked' | 'failed' | 'pending'
  word_count: number
  target_words: number
  warning_count: number
  children: SectionNode[]
}

export interface ProjectMeta {
  project_id: string
  title: string
  file_path: string | null
  section_count: number
  generated: number
  blocked: number
  failed: number
  pending: number
  total_words: number
}

/** One row of the library listing, enough to render a book cover. */
export interface ProjectSummary {
  project_id: string
  title: string
  file_path: string | null
  section_count: number
  total_words: number
}

export interface ProjectOut {
  meta: ProjectMeta
  tree: SectionNode[]
}

export interface SectionDetail {
  section_id: string
  title: string
  level: number
  description: string
  text: string
  status: string
  warnings: WarningOut[]
  sources: SourceRefOut[]
  missing_fields: string[]
  model: string
}

export interface RunHandleOut {
  run_id: string
  project_id: string
  kind: 'run' | 'rewrite' | 'merge' | 'format'
  status: 'running' | 'done' | 'cancelled' | 'error'
  error: string | null
  summary: Record<string, number>
}

export interface ProviderOut {
  name: string
  model: string
  ready: boolean
}

export interface HealthOut {
  status: string
  store: string
  research_enabled: boolean
  providers: ProviderOut[]
}

export interface TreeOut {
  project_id: string
  section_id?: string | null
  project: ProjectOut
}

export interface CompleteOut {
  completion: string
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

export class Api {
  constructor(readonly baseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init
    })
    if (!response.ok) {
      let detail = response.statusText
      try {
        const body = await response.json()
        if (body?.detail) detail = String(body.detail)
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(response.status, detail)
    }
    return (await response.json()) as T
  }

  health(): Promise<HealthOut> {
    return this.request('/api/health')
  }

  listProjects(): Promise<ProjectSummary[]> {
    return this.request('/api/projects')
  }

  openProject(filePath: string): Promise<ProjectOut> {
    return this.request('/api/projects/open', {
      method: 'POST',
      body: JSON.stringify({ file_path: filePath })
    })
  }

  newProject(title: string): Promise<ProjectOut> {
    return this.request('/api/projects/new', {
      method: 'POST',
      body: JSON.stringify({ title })
    })
  }

  getProject(projectId: string): Promise<ProjectOut> {
    return this.request(`/api/projects/${projectId}`)
  }

  getSection(projectId: string, sectionId: string): Promise<SectionDetail> {
    return this.request(`/api/projects/${projectId}/sections/${sectionId}`)
  }

  saveSection(projectId: string, sectionId: string, text: string): Promise<SectionDetail> {
    return this.request(`/api/projects/${projectId}/sections/${sectionId}`, {
      method: 'PUT',
      body: JSON.stringify({ text })
    })
  }

  validate(sectionId: string, text: string): Promise<WarningOut[]> {
    return this.request('/api/validate', {
      method: 'POST',
      body: JSON.stringify({ section_id: sectionId, text })
    })
  }

  startRun(projectId: string, prompt: string): Promise<RunHandleOut> {
    return this.request(`/api/projects/${projectId}/run`, {
      method: 'POST',
      body: JSON.stringify({ prompt })
    })
  }

  startRewrite(projectId: string, instruction: string, sectionIds: string[]): Promise<RunHandleOut> {
    return this.request(`/api/projects/${projectId}/rewrite`, {
      method: 'POST',
      body: JSON.stringify({ instruction, section_ids: sectionIds })
    })
  }

  startRestructure(projectId: string, instruction: string): Promise<RunHandleOut> {
    return this.request(`/api/projects/${projectId}/restructure`, {
      method: 'POST',
      body: JSON.stringify({ instruction })
    })
  }

  startFormat(projectId: string): Promise<RunHandleOut> {
    return this.request(`/api/projects/${projectId}/format`, { method: 'POST' })
  }

  cancelRun(runId: string): Promise<{ ok: boolean }> {
    return this.request(`/api/runs/${runId}/cancel`, { method: 'POST' })
  }

  saveEvidence(projectId: string, answers: Record<string, string>): Promise<void> {
    return this.request(`/api/projects/${projectId}/evidence`, {
      method: 'POST',
      body: JSON.stringify({ answers })
    })
  }

  async export(projectId: string, fmt: 'md' | 'docx' | 'pdf', outPath?: string): Promise<string> {
    const params = new URLSearchParams({ fmt })
    if (outPath) params.set('out_path', outPath)
    const out = await this.request<{ path: string; format: string }>(
      `/api/projects/${projectId}/export?${params}`
    )
    return out.path
  }

  deleteProject(projectId: string): Promise<{ ok: boolean }> {
    return this.request(`/api/projects/${projectId}`, { method: 'DELETE' })
  }

  preview(projectId: string, opts?: { withTitle?: boolean }): Promise<string> {
    const with_title = opts?.withTitle === false ? 0 : 1
    return this.request<{ markdown: string }>(
      `/api/projects/${projectId}/preview?with_title=${with_title}`
    ).then((r) => r.markdown)
  }

  getHistory(projectId: string): Promise<
    { ts: number; label: string; sections: { section_id: string; title: string; model: string }[] }[]
  > {
    return this.request(`/api/projects/${projectId}/history`)
  }

  restoreHistory(projectId: string, ts: number): Promise<ProjectOut> {
    return this.request(`/api/projects/${projectId}/history/restore?ts=${ts}`, {
      method: 'POST'
    })
  }

  getModels(): Promise<{
    current: { name: string; model: string } | null
    providers: {
      name: string
      base_url: string
      model: string
      models: string[]
      ready: boolean
      local: boolean
    }[]
  }> {
    return this.request('/api/models')
  }

  selectModel(name: string, model?: string): Promise<{ ok: boolean }> {
    return this.request('/api/models/select', {
      method: 'POST',
      body: JSON.stringify({ name, model: model ?? null })
    })
  }

  configureProvider(body: {
    name: string
    base_url: string
    api_key: string
    model?: string
  }): Promise<{ ok: boolean; name: string; models: string[] }> {
    return this.request('/api/models/configure', {
      method: 'POST',
      body: JSON.stringify(body)
    })
  }

  deleteProvider(name: string): Promise<{ ok: boolean; name: string }> {
    return this.request(`/api/models/${encodeURIComponent(name)}`, {
      method: 'DELETE'
    })
  }

  renameProject(projectId: string, title: string): Promise<ProjectOut> {
    return this.request(`/api/projects/${projectId}/rename`, {
      method: 'PATCH',
      body: JSON.stringify({ title })
    })
  }

  // -- section tree management ---------------------------------------------

  addSection(
    projectId: string,
    body: { title: string; parent_id?: string | null; after_section_id?: string | null }
  ): Promise<TreeOut> {
    return this.request(`/api/projects/${projectId}/sections`, {
      method: 'POST',
      body: JSON.stringify(body)
    })
  }

  renameSection(projectId: string, sectionId: string, title: string): Promise<TreeOut> {
    return this.request(`/api/projects/${projectId}/sections/${sectionId}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ title })
    })
  }

  deleteSection(projectId: string, sectionId: string): Promise<TreeOut> {
    return this.request(`/api/projects/${projectId}/sections/${sectionId}`, {
      method: 'DELETE'
    })
  }

  /** Save the whole-document draft as plain text; prose under a matching heading is synced back into that section. */
  freewrite(projectId: string, markdown: string): Promise<TreeOut> {
    return this.request(`/api/projects/${projectId}/freewrite`, {
      method: 'PUT',
      body: JSON.stringify({ markdown })
    })
  }

  /** Whole-document draft text (saved blob, or assembled tree preview when none). */
  getDraft(projectId: string): Promise<string> {
    return this.request<{ markdown: string }>(`/api/projects/${projectId}/draft`).then(
      (r) => r.markdown
    )
  }

  /** Short inline continuation for the editor's ghost suggestion. */
  complete(textBefore: string, textAfter: string): Promise<CompleteOut> {
    return this.request('/api/complete', {
      method: 'POST',
      body: JSON.stringify({ text_before: textBefore, text_after: textAfter })
    })
  }
}
