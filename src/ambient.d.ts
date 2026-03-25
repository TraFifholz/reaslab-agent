// Ambient type declarations for missing npm packages

declare module "fuzzysort" {
  interface Result {
    score: number
    target: string
    indexes: number[]
    obj?: any
  }
  interface Options {
    threshold?: number
    limit?: number
    keys?: string[]
    key?: string
    scoreFn?: (a: any) => number
  }
  function go(search: string, targets: any[], options?: Options): Result[]
  function single(search: string, target: string): Result | null
  function highlight(result: Result, open?: string, close?: string): string
  export default { go, single, highlight }
}

declare module "@zip.js/zip.js" {
  export class ZipReader {
    constructor(reader: any)
    getEntries(): Promise<any[]>
    close(): Promise<void>
  }
  export class BlobReader {
    constructor(blob: Blob)
  }
  export class TextWriter {
    constructor()
  }
  export class BlobWriter {
    constructor()
  }
}

declare module "@parcel/watcher" {
  export interface Event {
    type: "create" | "update" | "delete"
    path: string
  }
  export interface Options {
    ignore?: string[]
  }
  export type AsyncSubscription = {
    unsubscribe(): Promise<void>
  }
  export function subscribe(
    dir: string,
    fn: (err: Error | null, events: Event[]) => void,
    opts?: Options,
  ): Promise<AsyncSubscription>
}

declare module "vscode-jsonrpc/node" {
  export function createMessageConnection(input: any, output: any): any
  export class StreamMessageReader {
    constructor(stream: any)
  }
  export class StreamMessageWriter {
    constructor(stream: any)
  }
}

declare module "gitlab-ai-provider" {
  export function createGitlabAI(opts: any): any
}

declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, opts?: any)
    exec(sql: string): void
    prepare(sql: string): any
    close(): void
  }
}
