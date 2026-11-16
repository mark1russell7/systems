// @mark1russell7/service/http-folder: a request handler that serves the files of one folder, for
// example a built page next to the routes of a service, on one origin. The handler goes in the list
// of mounts of `./http`. The entry `./http` loads node:http and node:net only, thus this handler has
// an entry of its own: it reads files with node:fs and paths with node:path and @mark1russell7/files.

export type { FolderHandlerOptions } from "./http/folder.ts";
export { contentTypeOf, FOLDER_CONTENT_SECURITY_POLICY, folderHandler, UNKNOWN_CONTENT_TYPE, WEB_CONTENT_TYPES } from "./http/folder.ts";
