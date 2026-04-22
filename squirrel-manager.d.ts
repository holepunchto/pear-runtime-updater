export interface SquirrelPayloadFeed {
  type: 'feed'
  feed: string
}

export interface SquirrelPayloadInstaller {
  type: 'installer'
  file: string
}

export type SquirrelPayload = SquirrelPayloadFeed | SquirrelPayloadInstaller

export interface SquirrelApplyOptions {
  app?: string
  updateExe?: string
  updateArgs?: string[]
  installerArgs?: string[]
}

declare class SquirrelManager {
  isSquirrelName(name: string): boolean
  payloadFromPath(targetPath: string): Promise<SquirrelPayload | null>
  findCandidate(
    checkout: any,
    appRoot: string,
    opts?: { name?: string }
  ): Promise<{ key: string; prefix: string; score: number } | null>
  apply(
    payloadOrPath: SquirrelPayload | string,
    opts?: SquirrelApplyOptions
  ): Promise<SquirrelPayload>
}

export = SquirrelManager
