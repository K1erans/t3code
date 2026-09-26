/**
 * A plugin screen in the right panel. Loaded lazily, so clients without plugin tabs never
 * download it.
 *
 * The frame loads a signed URL from the thread's environment inside an opaque-origin
 * sandbox. The screen's runtime (`apps/server/src/plugins/screenRuntime.ts`) announces
 * itself with a message from the frame's window, and the host answers with the screen's
 * context. The frame is recognized by `event.source`, never by origin, which is `"null"`.
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
import { type ReactNode, useEffect, useRef, useState } from "react";

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
import { useTheme } from "~/hooks/useTheme";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { useEnvironmentOperateAccess } from "../settings/EnvironmentIconPicker";
import { pluginActionErrorText } from "../settings/PluginsSettings.logic";

/** How long before its token expires an open screen fetches a new URL. */
const URL_RENEW_MARGIN_MS = 10 * 60 * 1000;

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
  // The URL's token expires; an open screen gets a new one shortly before, which reloads it.
  const expiresAt = minted._tag === "Success" ? minted.value.expiresAt : undefined;
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = setTimeout(refreshUrl, Math.max(0, expiresAt - Date.now() - URL_RENEW_MARGIN_MS));
    return () => clearTimeout(timer);
  }, [expiresAt, refreshUrl]);
  const { resolvedTheme } = useTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const context = {
    placement: screen.placement,
    projectId: props.projectId,
    theme: { appearance: resolvedTheme },
  };
  // The handshake can arrive at any time after render; it reads the latest context.
  const contextRef = useRef(context);
  useEffect(() => {
    contextRef.current = context;
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      if (frame == null || event.source !== frame) return;
      if (typeof event.data !== "object" || event.data?.type !== "t3-screen:hello") return;
      frame.postMessage({ type: "t3-screen:init", context: contextRef.current }, "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (minted._tag === "Failure") {
    return (
      <PluginScreenNotice
        title={`Could not open ${screen.title}`}
        description="The environment did not provide this screen. Reopen the tab to try again."
      />
    );
  }
  const url =
    minted._tag === "Success" && connection._tag === "Some"
      ? resolveAssetUrl(connection.value.httpBaseUrl, minted.value.relativeUrl)
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
