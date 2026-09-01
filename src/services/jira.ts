import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
const FormData: any = require('form-data');

export class JiraService {
  constructor(
    private readonly baseUrl: string,
    private readonly email: string,
    private readonly apiToken: string
  ) {}

  private get auth(): string {
    return Buffer.from(`${this.email}:${this.apiToken}`).toString('base64');
  }

  private async fetch(endpoint: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/rest/api/3${endpoint}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Basic ${this.auth}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jira ${res.status}: ${body}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async getProjects(): Promise<{ key: string; name: string }[]> {
    const data = await this.fetch('/project/search?maxResults=100');
    return (data.values || []).map((p: any) => ({ key: p.key, name: p.name }));
  }

  async attachFileToIssue(issueKey: string, filePath: string): Promise<void> {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), path.basename(filePath));

    const res = await fetch(
      `${this.baseUrl.replace(/\/$/, '')}/rest/api/3/issue/${issueKey}/attachments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${this.auth}`,
          'X-Atlassian-Token': 'no-check',
          ...form.getHeaders(),
        },
        body: form as any,
      }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jira attach ${res.status}: ${body}`);
    }
  }

  async addComment(issueKey: string, text: string): Promise<void> {
    await this.fetch(`/issue/${issueKey}/comment`, {
      method: 'POST',
      body: JSON.stringify({
        body: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        },
      }),
    });
  }
}
