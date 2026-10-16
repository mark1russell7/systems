import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A tool is a binary that the lab downloads, at one pinned release, for each platform. The lab
 * keeps it in the cache folder of this package and does not install it on the system. Each use
 * compares its sha256 with the pinned value.
 */
export interface Tool {
  readonly name: "kind" | "kubectl";
  readonly version: string;
  /** These are the release assets, by the platform and the architecture of Node: `win32-x64`, `linux-x64`. */
  readonly assets: Readonly<Record<string, { readonly url: string; readonly sha256: string }>>;
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

/**
 * This function gives the path of a tool, after a download when the cache does not have it. It
 * refuses bytes whose sha256 is not the pinned value, from the cache or from the download.
 */
export const ensureTool = async (tool: Tool, key: string = platformKey(), cache: string = cacheFolder()): Promise<string> => {
  const asset = tool.assets[key];
  if (asset === undefined) throw new Error(`${tool.name} ${tool.version} has no pinned asset for ${key}`);
  const path = toolPath(tool, key, cache);
  if (existsSync(path)) {
    const found = sha256(readFileSync(path));
    if (found !== asset.sha256) throw new Error(`${path} has the sha256 ${found}, not the pinned ${asset.sha256}`);
    return path;
  }
  const response = await fetch(asset.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`the download of ${asset.url} answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const found = sha256(bytes);
  if (found !== asset.sha256) throw new Error(`${asset.url} has the sha256 ${found}, not the pinned ${asset.sha256}`);
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  writeFileSync(partial, bytes);
  if (!key.startsWith("win32")) chmodSync(partial, 0o755);
  renameSync(partial, path);
  return path;
};
