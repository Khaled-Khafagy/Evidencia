import * as fs from 'fs';
import * as path from 'path';
import { AppConfig } from './types';

const ZEPHYR_CLOUD_BASE = 'https://api.zephyrscale.smartbear.com/v2';

interface CreateExecutionParams {
  testCaseKey: string;
  testCycleKey: string;
  projectKey: string;
  status: 'Pass' | 'Fail' | 'In Progress' | 'Not Executed';
  comment?: string;
}

// Zephyr Scale has two incompatible APIs:
//  - Cloud (Jira on *.atlassian.net): SmartBear-hosted REST API, JWT token.
//  - Server/DC (self-hosted Jira): TM4J API at {jiraBaseUrl}/rest/atm/1.0,
//    authenticated with the Jira credentials (PAT bearer, or basic auth).
export class ZephyrService {
  private readonly isServer: boolean;

  constructor(private readonly config: AppConfig) {
    this.isServer =
      !!config.jiraBaseUrl && !config.jiraBaseUrl.includes('.atlassian.net');
  }

  private get baseUrl(): string {
    return this.isServer
      ? `${this.config.jiraBaseUrl.replace(/\/$/, '')}/rest/atm/1.0`
      : ZEPHYR_CLOUD_BASE;
  }

  private get authHeader(): string {
    if (!this.isServer) return `Bearer ${this.config.zephyrApiToken}`;
    // Jira DC personal access tokens use Bearer; fall back to basic auth
    // (email:password) when no separate token is configured.
    if (this.config.jiraApiToken) return `Bearer ${this.config.jiraApiToken}`;
    return `Basic ${Buffer.from(`${this.config.jiraEmail}:${this.config.zephyrApiToken}`).toString('base64')}`;
  }

  private async fetch(endpoint: string, options: RequestInit = {}): Promise<any> {
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Zephyr ${res.status}: ${body}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // Fetches every page of a cloud list endpoint (values/isLast/next contract).
  private async fetchAllPages(endpoint: string, pageSize = 200): Promise<any[]> {
    const all: any[] = [];
    let startAt = 0;
    for (;;) {
      const sep = endpoint.includes('?') ? '&' : '?';
      const data = await this.fetch(`${endpoint}${sep}maxResults=${pageSize}&startAt=${startAt}`);
      const values = data.values || [];
      all.push(...values);
      if (data.isLast || values.length === 0) break;
      startAt += values.length;
    }
    return all;
  }

  // Fetches every page of a server (TM4J) search endpoint, which returns a
  // bare array and paginates via startAt/maxResults.
  private async fetchAllServerPages(endpoint: string, pageSize = 200): Promise<any[]> {
    const all: any[] = [];
    let startAt = 0;
    for (;;) {
      const data = await this.fetch(`${endpoint}&maxResults=${pageSize}&startAt=${startAt}`);
      const values = Array.isArray(data) ? data : [];
      all.push(...values);
      if (values.length < pageSize) break;
      startAt += values.length;
    }
    return all;
  }

  async getTestCases(projectKey: string): Promise<{ key: string; name: string }[]> {
    if (this.isServer) {
      const query = encodeURIComponent(`projectKey = "${projectKey}"`);
      const data = await this.fetchAllServerPages(`/testcase/search?query=${query}`);
      return data.map((tc: any) => ({ key: tc.key, name: tc.name }));
    }
    const data = await this.fetchAllPages(`/testcases?projectKey=${projectKey}`);
    return data.map((tc: any) => ({ key: tc.key, name: tc.name }));
  }

  async getTestCycles(projectKey: string): Promise<{ key: string; name: string }[]> {
    if (this.isServer) {
      const query = encodeURIComponent(`projectKey = "${projectKey}"`);
      const data = await this.fetchAllServerPages(`/testrun/search?query=${query}`);
      return data.map((tr: any) => ({ key: tr.key, name: tr.name }));
    }
    const data = await this.fetchAllPages(`/testcycles?projectKey=${projectKey}`);
    return data.map((tc: any) => ({ key: tc.key, name: tc.name }));
  }

  // Returns the test cases contained in a cycle (with names), or null when
  // the API can't provide them cheaply (cloud), meaning "don't filter".
  async getTestCasesInCycle(testCycleKey: string): Promise<{ key: string; name: string }[] | null> {
    if (this.isServer) {
      const data = await this.fetch(`/testrun/${testCycleKey}`);
      // item shape varies across TM4J versions
      const keys: string[] = (data.items || [])
        .map((item: any) => item.testCaseKey || item.testCase?.key || item.key)
        .filter(Boolean);
      // run items carry no names; resolve them per key, tolerating failures
      return Promise.all(
        keys.map(async key => {
          try {
            const tc = await this.fetch(`/testcase/${key}`);
            return { key, name: tc.name || key };
          } catch {
            return { key, name: key };
          }
        })
      );
    }
    return null;
  }

  async createTestExecution(params: CreateExecutionParams): Promise<{ id: number; key: string }> {
    if (this.isServer) {
      const body = { status: params.status, comment: params.comment };
      const data = params.testCycleKey
        ? await this.fetch(
            `/testrun/${params.testCycleKey}/testcase/${params.testCaseKey}/testresult`,
            { method: 'POST', body: JSON.stringify(body) }
          )
        : await this.fetch('/testresult', {
            method: 'POST',
            body: JSON.stringify({
              projectKey: params.projectKey,
              testCaseKey: params.testCaseKey,
              ...body,
            }),
          });
      return { id: data.id, key: params.testCycleKey || String(data.id) };
    }
    const data = await this.fetch('/testexecutions', {
      method: 'POST',
      body: JSON.stringify({
        projectKey: params.projectKey,
        testCaseKey: params.testCaseKey,
        testCycleKey: params.testCycleKey,
        statusName: params.status,
        comment: params.comment,
      }),
    });
    return { id: data.id, key: data.key };
  }

  // Updates the status of an existing execution (created when recording
  // started) rather than creating a second one.
  async updateTestExecution(params: {
    executionIdOrKey: number | string;
    testCaseKey: string;
    testCycleKey: string;
    status: CreateExecutionParams['status'];
    comment?: string;
  }): Promise<void> {
    if (this.isServer) {
      // TM4J: PUT on the run item updates its latest test result
      if (params.testCycleKey) {
        await this.fetch(
          `/testrun/${params.testCycleKey}/testcase/${params.testCaseKey}/testresult`,
          { method: 'PUT', body: JSON.stringify({ status: params.status, comment: params.comment }) }
        );
      } else {
        await this.fetch(`/testresult/${params.executionIdOrKey}`, {
          method: 'PUT',
          body: JSON.stringify({ status: params.status, comment: params.comment }),
        });
      }
      return;
    }
    await this.fetch(`/testexecutions/${params.executionIdOrKey}`, {
      method: 'PUT',
      body: JSON.stringify({ statusName: params.status, comment: params.comment }),
    });
  }

  async attachFileToExecution(executionId: number, filePath: string): Promise<void> {
    // Native FormData/Blob: buffers the file instead of streaming, which
    // Node's fetch cannot send without hanging.
    const form = new FormData();
    const fileData = fs.readFileSync(filePath);
    form.append('file', new Blob([fileData]), path.basename(filePath));

    const endpoint = this.isServer
      ? `${this.baseUrl}/testresult/${executionId}/attachments`
      : `${this.baseUrl}/testexecutions/${executionId}/attachments`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'X-Atlassian-Token': 'no-check',
      },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Zephyr attach ${res.status}: ${body}`);
    }
  }
}
