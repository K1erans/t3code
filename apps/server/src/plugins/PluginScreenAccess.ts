/**
 * Serves plugin screens from signed, directory-scoped `/api/plugins/<token>/…` URLs.
 *
 * A remote client authenticates with per-request headers that an `<iframe src>` cannot
 * carry, so the URL itself is the credential, as for HTML previews in `AssetAccess`. The
 * token names a plugin screen, not a path: every request re-checks that the plugin is
 * still enabled, working and at the minted revision, and serves only files under the
 * screen entry's folder. The CSP `sandbox` header gives each screen an opaque origin, so it
 * never sees T3's cookies, storage or API credentials, even on the app's own origin.
 */
import {
  PLUGIN_SCREEN_SANDBOX,
  PluginScreenUnavailableError,
  type PluginScreenUrlInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as PluginPackageManager from "./PluginPackageManager.ts";
import { SCREEN_RUNTIME_SOURCE } from "./screenRuntime.ts";

export const PLUGIN_SCREEN_ROUTE_PREFIX = "/api/plugins";

const SIGNING_SECRET_NAME = "plugin-screen-signing-key";
/** Long enough that an open screen can lazy-load chunks; reloads mint a new URL anyway. */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RUNTIME_PATH = "_t3/screen.js";

// The header also sandboxes the document when it is opened directly, outside any frame.
const SCREEN_CONTENT_SECURITY_POLICY = [
  `sandbox ${PLUGIN_SCREEN_SANDBOX}`,
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https: wss:",
  "img-src 'self' https: data: blob:",
  "media-src 'self' https: data: blob:",
  "font-src 'self' https: data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const ScreenClaims = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    pluginId: Schema.String,
    screenId: Schema.String,
    pluginVersion: Schema.String,
    revision: Schema.Number,
    expiresAt: Schema.Number,
  }),
);
const encodeClaims = Schema.encodeSync(ScreenClaims);
const decodeClaims = Schema.decodeUnknownOption(ScreenClaims);

const signingSecret = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  return yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
});

/** Mints the URL of a listed screen's entry. The client must name the revision it shows. */
export const issueScreenUrl = Effect.fn("PluginScreenAccess.issueScreenUrl")(function* (
  input: PluginScreenUrlInput,
) {
  const unavailable = new PluginScreenUnavailableError({
    pluginId: input.pluginId,
    screenId: input.screenId,
  });
  const manager = yield* PluginPackageManager.PluginPackageManager;
  const screen = yield* manager.screen(input.pluginId, input.screenId);
  if (screen === undefined || screen.revision !== input.revision) return yield* unavailable;
  const secret = yield* signingSecret.pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to load the plugin screen signing key.", { cause }),
    ),
    Effect.mapError(() => unavailable),
  );
  const expiresAt = (yield* Clock.currentTimeMillis) + TOKEN_TTL_MS;
  const payload = base64UrlEncode(
    encodeClaims({
      version: 1,
      pluginId: input.pluginId,
      screenId: input.screenId,
      pluginVersion: screen.version,
      revision: screen.revision,
      expiresAt,
    }),
  );
  const token = `${payload}.${signPayload(payload, secret)}`;
  return {
    relativeUrl: `${PLUGIN_SCREEN_ROUTE_PREFIX}/${token}/${encodeURIComponent(screen.entry)}`,
    expiresAt,
  };
});

type ResolvedScreenFile =
  | { readonly kind: "runtime" }
  | { readonly kind: "file"; readonly path: string; readonly contentType: string };

/** Path segments under the screen folder, or undefined for anything that could escape it. */
const decodeSegments = (relativePath: string): ReadonlyArray<string> | undefined => {
  try {
    const segments = relativePath.split("/").map(decodeURIComponent);
    const unsafe = segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.startsWith(".") ||
        segment.includes("/") ||
        segment.includes("\\") ||
        segment.includes("\0"),
    );
    return unsafe ? undefined : segments;
  } catch {
    return undefined;
  }
};

/**
 * The file `relativePath` names under a token's screen, or undefined when the token is
 * invalid or expired, the plugin is no longer at the minted revision, or the file is not
 * a servable file inside the screen's folder.
 */
export const resolveScreenFile = Effect.fn("PluginScreenAccess.resolveScreenFile")(function* (
  token: string,
  relativePath: string,
) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return undefined;
  const secret = yield* signingSecret.pipe(Effect.orElseSucceed(() => null));
  if (secret === null) return undefined;
  if (!timingSafeEqualBase64Url(signature, signPayload(payload, secret))) return undefined;
  const claims = Option.getOrUndefined(
    yield* Effect.try(() => base64UrlDecodeUtf8(payload)).pipe(
      Effect.map(decodeClaims),
      Effect.orElseSucceed(() => Option.none()),
    ),
  );
  if (claims === undefined || claims.expiresAt <= (yield* Clock.currentTimeMillis)) {
    return undefined;
  }

  const manager = yield* PluginPackageManager.PluginPackageManager;
  const screen = yield* manager.screen(claims.pluginId, claims.screenId);
  if (
    screen === undefined ||
    screen.version !== claims.pluginVersion ||
    screen.revision !== claims.revision
  ) {
    return undefined;
  }
  if (relativePath === RUNTIME_PATH) return { kind: "runtime" } satisfies ResolvedScreenFile;

  const segments = decodeSegments(relativePath);
  if (segments === undefined) return undefined;
  const path = yield* Path.Path;
  const contentType = CONTENT_TYPES[path.extname(segments.at(-1) ?? "").toLowerCase()];
  if (contentType === undefined) return undefined;
  const filePath = path.join(screen.root, ...segments);
  // Segments are already checked; this guards the folder boundary itself.
  if (!filePath.startsWith(`${screen.root}${path.sep}`)) return undefined;
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File") return undefined;
  return { kind: "file", path: filePath, contentType } satisfies ResolvedScreenFile;
});

const screenHeaders = (contentType: string): Record<string, string> => ({
  "Content-Type": contentType,
  "Content-Security-Policy": SCREEN_CONTENT_SECURITY_POLICY,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  // Module scripts and fonts from an opaque origin are CORS requests with `Origin: null`.
  // The URL is the credential, so any origin may read it, never with cookies.
  "Access-Control-Allow-Origin": "*",
  // Revalidate every load, so a disable or reload revokes cached copies too.
  "Cache-Control": "private, no-cache",
});

const serveScreenFile = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const suffix = url.value.pathname.slice(`${PLUGIN_SCREEN_ROUTE_PREFIX}/`.length);
  const separator = suffix.indexOf("/");
  if (separator <= 0) return HttpServerResponse.text("Not Found", { status: 404 });

  const resolved = yield* resolveScreenFile(
    suffix.slice(0, separator),
    suffix.slice(separator + 1),
  );
  if (resolved === undefined) return HttpServerResponse.text("Not Found", { status: 404 });
  if (resolved.kind === "runtime") {
    return HttpServerResponse.text(SCREEN_RUNTIME_SOURCE, {
      headers: screenHeaders("text/javascript; charset=utf-8"),
    });
  }
  return yield* HttpServerResponse.file(resolved.path, {
    headers: screenHeaders(resolved.contentType),
  }).pipe(
    Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
  );
});

/** Route handlers run with the server's services, so the manager is captured at build time. */
export const pluginScreenRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const manager = yield* PluginPackageManager.PluginPackageManager;
    return HttpRouter.add(
      "GET",
      `${PLUGIN_SCREEN_ROUTE_PREFIX}/*`,
      serveScreenFile.pipe(
        Effect.provideService(PluginPackageManager.PluginPackageManager, manager),
      ),
    );
  }),
);
