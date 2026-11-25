export type Role = 'proxy' | 'backend';

/** How much RAM a server may get. All values in MB. */
export interface MemorySettings {
  /** Share of the network budget relative to other servers (default: proxy 1, backend 4). */
  weight?: number;
  /** Never give less than this heap (default: proxy 256, backend 512). */
  minMb?: number;
  /** Never give more than this heap (default: unlimited). */
  maxMb?: number;
  /** Fixed heap, ignores weight (use for servers whose size you know). */
  pinnedMb?: number;
}

export interface ServerConfig {
  /** Lowercase letters, digits, "-" and "_"; also the name used in velocity.toml. */
  id: string;
  name: string;
  role: Role;
  /** Folder of the server, relative to the data directory. */
  dir: string;
  /** Start together with the network. */
  autoStart: boolean;
  /** Minecraft port: the public port of the proxy, or the local port of a backend. */
  port?: number;
  /** Backends only: players join this server first (the proxy's "try" list). */
  entry?: boolean;
  /** `dir` is an absolute folder outside the data directory (an imported server that is used where it is). */
  external?: boolean;
  /** Managed and monitored, but not behind the proxy (software that cannot receive forwarded players). */
  standalone?: boolean;
  /** Existing server brought in from outside; an imported proxy keeps the servers it already lists. */
  imported?: boolean;
  memory: MemorySettings;
}

export interface HttpConfig {
  host: string;
  port: number;
  /** Required for every request when set; mandatory when host is not a loopback address. */
  token: string;
}

export interface RamConfig {
  /** Memory MCNetwork may plan with; 0 = detect (container limit or physical RAM). */
  totalMb: number;
  /** Left for the OS and everything that is not Minecraft; 0 = automatic. */
  reserveMb: number;
  /** Seconds between RAM samples. */
  sampleSeconds: number;
}

export interface AgentConfigSettings {
  /** Install and use the Paper/Velocity plugins that report heap, TPS and players. */
  enabled: boolean;
  /** Secret the plugins send with every report; generated on the first run. */
  token: string;
}

export interface NetworkConfig {
  /** Path to mcli.js (relative paths are resolved against the data directory). */
  mcliPath: string;
  http: HttpConfig;
  ram: RamConfig;
  agent: AgentConfigSettings;
  servers: ServerConfig[];
}
