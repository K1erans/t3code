/**
 * A plugin screen in the right panel. Loaded lazily, so clients without plugin tabs never
 * download it.
 *
 * The frame loads a signed URL from the thread's environment inside an opaque-origin
 * sandbox. The screen's runtime (`apps/server/src/plugins/screenRuntime.ts`) announces
 * itself with a message from the frame's window, and the host answers with the screen's
 * context and theme, then sends the theme again whenever it changes. The frame is
 * recognized by `event.source`, never by origin, which is `"null"`.
 */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { type EnvironmentId, PLUGIN_SCREEN_SANDBOX, type PluginScreen } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { PuzzleIcon } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { toastManager } from "~/components/ui/toast";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { useEnvironmentOperateAccess } from "../settings/EnvironmentIconPicker";
import { pluginActionErrorText } from "../settings/PluginsSettings.logic";
import { readScreenTheme, sameScreenTheme, type ScreenTheme } from "./pluginScreenTheme";

/** How long before its token expires an open screen fetches a new URL. */
const URL_RENEW_MARGIN_MS = 10 * 60 * 1000;
/** How soon a failed URL renewal is retried. */
const URL_RENEW_RETRY_MS = 60 * 1000;

interface PluginScreenPanelProps {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly screenId: string;
  readonly title: string;
  /** The project of the thread beside the panel. */
  readonly projectId: string | null;
  /** Hidden screens are destroyed and rebuilt when shown again. */
  readonly visible: boolean;
}

export default function PluginScreenPanel(props: PluginScreenPanelProps) {
  const catalog = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(
        serverEnvironment.pluginCommands({ environmentId: props.environmentId, input: {} }),
      ),
    ),
  );
  if (catalog === null) return null;
  const screen = catalog.screens.find(
    (entry) => entry.pluginId === props.pluginId && entry.id === props.screenId,
  );
  if (screen === undefined) return <PluginScreenPlaceholder {...props} />;
  if (!props.visible) return null;
  const projectId = screen.scope === "project" ? props.projectId : null;
  // A reload changes the revision, so the frame is rebuilt from a freshly minted URL. The
  // screen is told its project only when it connects, so another project rebuilds it too.
  return (
    <PluginScreenFrame
      key={`${screen.revision}:${projectId ?? ""}`}
      environmentId={props.environmentId}
      screen={screen}
      projectId={projectId}
    />
  );
}

function PluginScreenFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly screen: PluginScreen;
  readonly projectId: string | null;
}) {
  const { environmentId, screen } = props;
  const connection = usePreparedConnection(environmentId);
  const urlAtom = serverEnvironment.pluginScreenUrl({
    environmentId,
    input: { pluginId: screen.pluginId, screenId: screen.id, revision: screen.revision },
  });
  const minted = useAtomValue(urlAtom);
  const refreshUrl = useAtomRefresh(urlAtom);
  // A failed renewal keeps the last URL, which stays valid until its token expires.
  const current = Option.getOrUndefined(AsyncResult.value(minted));
  const renewalFailed = minted._tag === "Failure" && current !== undefined;
  // The URL's token expires; an open screen gets a new one shortly before, which reloads it,
  // and retries a failed renewal.
  const expiresAt = current?.expiresAt;
  useEffect(() => {
    const delay = renewalFailed
      ? URL_RENEW_RETRY_MS
      : expiresAt === undefined
        ? undefined
        : Math.max(0, expiresAt - Date.now() - URL_RENEW_MARGIN_MS);
    if (delay === undefined) return;
    const timer = setTimeout(refreshUrl, delay);
    return () => clearTimeout(timer);
  }, [expiresAt, renewalFailed, refreshUrl]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const { placement } = screen;
  const { projectId } = props;

  // A layout effect, so the listener exists in the same task that inserts the frame: the
  // frame's greeting is a posted message, delivered in a later task, and is never missed.
  useLayoutEffect(() => {
    // The theme the frame last received, or null until it was first sent. A page navigating
    // inside the frame is sent everything afresh.
    let lastSent: ScreenTheme | null = null;
    const sendInit = () => {
      const element = frameRef.current;
      const frame = element?.contentWindow;
      if (element == null || frame == null) return;
      lastSent = readScreenTheme(element);
      frame.postMessage(
        {
          type: "t3-screen:init",
          context: { placement, projectId, theme: { appearance: lastSent.appearance } },
          tokens: lastSent.tokens,
        },
        "*",
      );
    };
    // The runtime greets the host when it loads, or when the SDK loads it later. Only a page
    // that greets the host is told its context.
    const onMessage = (event: MessageEvent) => {
      if (event.source == null || event.source !== frameRef.current?.contentWindow) return;
      if (typeof event.data !== "object" || event.data?.type !== "t3-screen:hello") return;
      sendInit();
    };
    // Theme, appearance, contrast and text size settings all land on the root element.
    const observer = new MutationObserver(() => {
      const element = frameRef.current;
      const frame = element?.contentWindow;
      if (lastSent === null || element == null || frame == null) return;
      const theme = readScreenTheme(element);
      if (sameScreenTheme(theme, lastSent)) return;
      lastSent = theme;
      frame.postMessage({ type: "t3-screen:theme", ...theme }, "*");
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme-id"],
    });
    window.addEventListener("message", onMessage);
    return () => {
      observer.disconnect();
      window.removeEventListener("message", onMessage);
    };
  }, [placement, projectId]);

  if (current === undefined && minted._tag === "Failure") {
    return (
      <PluginScreenNotice
        title={`Could not open ${screen.title}`}
        description="The environment did not provide this screen. Reopen the tab to try again."
      />
    );
  }
  const url =
    current !== undefined && connection._tag === "Some"
      ? resolveAssetUrl(connection.value.httpBaseUrl, current.relativeUrl)
      : null;
  if (url === null) return null;
  return (
    <iframe
      ref={frameRef}
      src={url}
      title={screen.title}
      sandbox={PLUGIN_SCREEN_SANDBOX}
      referrerPolicy="no-referrer"
      className="size-full border-0 bg-background"
    />
  );
}

/** Why a screen cannot show, with the way back: Enable for a disabled plugin, Reload for a failed one. */
function PluginScreenPlaceholder(props: PluginScreenPanelProps) {
  const status = useEnvironmentQuery(
    serverEnvironment.pluginPackages({ environmentId: props.environmentId, input: {} }),
  );
  const canOperate = useEnvironmentOperateAccess(props.environmentId) === "granted";
  const enablePlugin = useAtomCommand(serverEnvironment.enablePluginPackage, {
    reportFailure: false,
  });
  const reloadPlugin = useAtomCommand(serverEnvironment.reloadPluginPackage, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  if (status.data == null) return null;
  const pluginPackage = status.data.packages.find((entry) => entry.id === props.pluginId);

  const run = (action: "enable" | "reload") => {
    if (pluginPackage === undefined) return;
    setPending(true);
    void (async () => {
      const command = action === "enable" ? enablePlugin : reloadPlugin;
      const result = await command({
        environmentId: props.environmentId,
        input: { id: pluginPackage.id },
      });
      setPending(false);
      // On success the catalog lists the screen again and the frame replaces this notice.
      if (result._tag === "Success") return;
      status.refresh();
      if (isAtomCommandInterrupted(result)) return;
      toastManager.add({
        type: "error",
        title: `Could not ${action} ${pluginPackage.name}`,
        description:
          pluginActionErrorText(squashAtomCommandFailure(result)) ?? "The plugin did not respond.",
      });
    })();
  };

  if (pluginPackage === undefined) {
    return (
      <PluginScreenNotice
        title={`${props.title} is not installed`}
        description="Its plugin is no longer installed in this environment."
      />
    );
  }
  if (pluginPackage.state === "error") {
    return (
      <PluginScreenNotice
        title={`${pluginPackage.name} failed`}
        description={pluginPackage.error ?? "The plugin stopped with an error."}
        action={
          canOperate ? (
            <Button size="sm" disabled={pending} onClick={() => run("reload")}>
              Reload
            </Button>
          ) : undefined
        }
      />
    );
  }
  if (!pluginPackage.enabled) {
    return (
      <PluginScreenNotice
        title={`${pluginPackage.name} is disabled`}
        description={`Enable the plugin to open ${props.title}.`}
        action={
          canOperate ? (
            <Button size="sm" disabled={pending} onClick={() => run("enable")}>
              Enable
            </Button>
          ) : undefined
        }
      />
    );
  }
  return (
    <PluginScreenNotice
      title={pluginPackage.state === "activating" ? `Starting ${pluginPackage.name}` : props.title}
      description={
        pluginPackage.state === "activating"
          ? "The screen opens once the plugin has loaded."
          : `${pluginPackage.name} no longer provides this screen.`
      }
    />
  );
}

function PluginScreenNotice(props: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PuzzleIcon />
        </EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      {props.action ? <EmptyContent>{props.action}</EmptyContent> : null}
    </Empty>
  );
}
