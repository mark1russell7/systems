import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

/**
 * A tool is a binary that the lab downloads, at one pinned release, for each platform. The lab
 * keeps it in the cache folder of this package and does not install it on the system. Each use
 * compares its sha256 with the pinned value.
 *
 * A tool with an `entry` comes in a gzipped tar file. The pinned sha256 is the sha256 of that file.
 * The cache keeps the file, and each use takes the entry from it again.
 */
export interface Tool {
  readonly name: "kind" | "kubectl" | "istioctl" | "helm";
  readonly version: string;
  /** These are the release assets, by the platform and the architecture of Node: `win32-x64`, `linux-x64`. */
  readonly assets: Readonly<Record<string, { readonly url: string; readonly sha256: string }>>;
  /** This name is the file of the tool in its gzipped tar file, or nothing for a tool that is its own asset. */
  readonly entry?: string | undefined;
}

/** This release of kind is v0.33.0, from 2026-08-26. Its default node image is Kubernetes 1.37.0. The sums are from its `.sha256sum` assets. */
export const KIND: Tool = {
  name: "kind",
  version: "v0.33.0",
  assets: {
    "win32-x64": {
      url: "https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-windows-amd64",
      sha256: "4b22adaa135368c5a465d56bbd8e520cbea87272a06ca00b6078e7b81515c9fc",
    },
    "linux-x64": {
      url: "https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-amd64",
      sha256: "aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d",
    },
    "linux-arm64": {
      url: "https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-arm64",
      sha256: "20022bee6cfcd5086cb7234d218e3454e6090022f2a8f55d1fa7fcf42c3867a2",
    },
    "darwin-arm64": {
      url: "https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-darwin-arm64",
      sha256: "0c8c7dbe5e23594a198b786c4bc13dacc101fa6196b0cb0b23a1ca44e61f4b4f",
    },
  },
};

/** This release of kubectl is v1.37.0, the version of the node image. The sums are from the `.sha256` files of `dl.k8s.io`. */
export const KUBECTL: Tool = {
  name: "kubectl",
  version: "v1.37.0",
  assets: {
    "win32-x64": {
      url: "https://dl.k8s.io/release/v1.37.0/bin/windows/amd64/kubectl.exe",
      sha256: "4721b614a67bb4932a0369e61f4a323d8c6ca00943d3a2ff14837c124da06f0e",
    },
    "linux-x64": {
      url: "https://dl.k8s.io/release/v1.37.0/bin/linux/amd64/kubectl",
      sha256: "6129359f4e1f3848a5572ccb0b26cf28b8ca08cef38c95a765b2f64a2c961a2f",
    },
    "linux-arm64": {
      url: "https://dl.k8s.io/release/v1.37.0/bin/linux/arm64/kubectl",
      sha256: "922df28df248cc00a9e025f947704f1d1482de64ece54cfe57e61f19eaf1eef3",
    },
    "darwin-arm64": {
      url: "https://dl.k8s.io/release/v1.37.0/bin/darwin/arm64/kubectl",
      sha256: "583beedaebe422e71d3f1a96acef8b1fef86ea2f09a45ad01aa6c9ce287c1380",
    },
  },
};

/**
 * This release of istioctl is 1.31.3, from 2026-10-22. It holds the charts of its own version, thus the
 * lab needs no other tool to install Istio. The sums are from the `.sha256` assets of the release. The
 * release has a zip file for Windows, and the lab reads only a gzipped tar file. Thus Windows has no asset.
 */
export const ISTIOCTL: Tool = {
  name: "istioctl",
  version: "1.31.3",
  entry: "istioctl",
  assets: {
    "linux-x64": {
      url: "https://github.com/istio/istio/releases/download/1.31.3/istioctl-1.31.3-linux-amd64.tar.gz",
      sha256: "382c3004ce2e9c5ed3064b092ae0da7f6bbe30c766a1be282f45725add004860",
    },
    "linux-arm64": {
      url: "https://github.com/istio/istio/releases/download/1.31.3/istioctl-1.31.3-linux-arm64.tar.gz",
      sha256: "7476801623dbb900073cb1dba6a23b6a15c564b7e92b208aed36829315fefff1",
    },
    "darwin-arm64": {
      url: "https://github.com/istio/istio/releases/download/1.31.3/istioctl-1.31.3-osx-arm64.tar.gz",
      sha256: "881c3b443d9e458e8f19feed6ffa187dcfcb03dc032cb56068f7d1d0cd976c82",
    },
  },
};

/**
 * This release of Helm is v3.22.1, from 2026-10-15. The lab installs Cilium from its chart with it.
 * The guide of Cilium 1.20.4 installs with Helm 3. The sums are from the `.sha256sum` files of
 * `get.helm.sh`. The tar file for Windows has `helm.exe`, not `helm`, thus Windows has no asset.
 */
export const HELM: Tool = {
  name: "helm",
  version: "v3.22.1",
  entry: "helm",
  assets: {
    "linux-x64": {
      url: "https://get.helm.sh/helm-v3.22.1-linux-amd64.tar.gz",
      sha256: "896cf63684a42a723d61c980369d6e588330927deb13676ca0d85006dd6da0ea",
    },
    "linux-arm64": {
      url: "https://get.helm.sh/helm-v3.22.1-linux-arm64.tar.gz",
      sha256: "4c29e286b279d170fa048ddfc3e4e83dcd069ca9c52102766ba672d7149e694d",
    },
    "darwin-arm64": {
      url: "https://get.helm.sh/helm-v3.22.1-darwin-arm64.tar.gz",
      sha256: "e73da8a0b0d5193774fdff17ce6319c7436bb22ee229b45fd64f3c40368c753a",
    },
  },
};

/**
 * This function gives the bytes of one file of a gzipped tar file. A header of the ustar format has
 * 512 bytes. It has the name at 0, the size in octal at 124, the type at 156 and the prefix of the
 * name at 345. The data follows the header, in blocks of 512 bytes. The match is on the last part of the
 * name. A link, a folder and an extended header are not a file, thus the search skips them.
 */
export const tarEntry = (gzipped: Uint8Array, entry: string): Uint8Array => {
  const tar = gunzipSync(gzipped);
  const text = (from: number, length: number): string => {
    const field = tar.subarray(from, from + length);
    const end = field.indexOf(0);
    return field.subarray(0, end === -1 ? field.length : end).toString("latin1");
  };
  let at = 0;
  while (at + 512 <= tar.length) {
    const name = text(at, 100);
    if (name === "") break;
    const size = Number.parseInt(text(at + 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size)) throw new Error(`the tar entry ${name} has no size in octal`);
    const type = String.fromCharCode(tar[at + 156] ?? 0);
    const prefix = text(at + 345, 155);
    const full = prefix === "" ? name : `${prefix}/${name}`;
    if ((type === "0" || type === "\0") && full.split("/").at(-1) === entry) return new Uint8Array(tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`the tar file has no file ${entry}`);
};

/** This folder is the cache of the tools: `.cache/` in this package, which git ignores. `KIND_CACHE` names another folder. */
export const cacheFolder = (): string =>
  process.env["KIND_CACHE"] ?? fileURLToPath(new URL("../.cache/", import.meta.url));

/** This function gives the platform key of this process, as the assets name it. */
export const platformKey = (platform: string = process.platform, arch: string = process.arch): string =>
  `${platform}-${arch}`;

/** This function gives the sha256 of some bytes, in hexadecimal. */
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** This function gives the path of a tool in the cache, for a platform. */
export const toolPath = (tool: Tool, key: string = platformKey(), cache: string = cacheFolder()): string =>
  join(cache, "tools", `${tool.name}-${tool.version}-${key}`, key.startsWith("win32") ? `${tool.name}.exe` : tool.name);

/** This function writes a file through a partial file, thus a stop in the middle leaves no file at the path. */
const writeWhole = (path: string, bytes: Uint8Array, executable: boolean): void => {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  writeFileSync(partial, bytes);
  if (executable) chmodSync(partial, 0o755);
  renameSync(partial, path);
};

/** These are the waits in ms before the second and the third try of a download. A runner can fail to connect for a moment. */
export const DOWNLOAD_WAITS: readonly number[] = [2_000, 8_000];

/**
 * This function gives the bytes of a URL. It tries again after each wait when the connection fails or
 * the answer is a 5xx. It refuses each other answer that is not ok at once.
 */
export const download = async (url: string, waits: readonly number[] = DOWNLOAD_WAITS): Promise<Uint8Array> => {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { redirect: "follow" }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    if (response instanceof Response && response.ok) return new Uint8Array(await response.arrayBuffer());
    const failure = response instanceof Response ? new Error(`the download of ${url} answered ${response.status}`) : response;
    const wait = waits[attempt];
    if ((response instanceof Response && response.status < 500) || wait === undefined) throw failure;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
};

/**
 * This function gives the path of a tool, after a download when the cache does not have it. It
 * refuses bytes whose sha256 is not the pinned value, from the cache or from the download. For a
 * tool in a tar file, the cache keeps the tar file beside the tool. Each use examines the tar file,
 * and writes the tool again when its bytes are not those of the entry.
 */
export const ensureTool = async (tool: Tool, key: string = platformKey(), cache: string = cacheFolder()): Promise<string> => {
  const asset = tool.assets[key];
  if (asset === undefined) throw new Error(`${tool.name} ${tool.version} has no pinned asset for ${key}`);
  const path = toolPath(tool, key, cache);
  const executable = !key.startsWith("win32");
  // the downloaded asset: the tool itself, or its tar file
  const kept = tool.entry === undefined ? path : `${path}.tar.gz`;
  let bytes: Uint8Array;
  if (existsSync(kept)) {
    bytes = readFileSync(kept);
    const found = sha256(bytes);
    if (found !== asset.sha256) throw new Error(`${kept} has the sha256 ${found}, not the pinned ${asset.sha256}`);
    if (tool.entry === undefined) return path;
  } else {
    bytes = await download(asset.url);
    const found = sha256(bytes);
    if (found !== asset.sha256) throw new Error(`${asset.url} has the sha256 ${found}, not the pinned ${asset.sha256}`);
    writeWhole(kept, bytes, executable && tool.entry === undefined);
    if (tool.entry === undefined) return path;
  }
  const binary = tarEntry(bytes, tool.entry);
  if (!existsSync(path) || sha256(readFileSync(path)) !== sha256(binary)) writeWhole(path, binary, executable);
  return path;
};
