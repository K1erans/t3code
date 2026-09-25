import type { PluginPackageStatus } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CircleAlertIcon,
  FolderCodeIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { resolvePrimaryOperateAccess } from "./ProviderSettingsPanel.logic";
import { searchableSetting } from "./settingsSearch";

const statePresentation = {
  active: { label: "Active", variant: "success" },
  disabled: { label: "Disabled", variant: "secondary" },
  error: { label: "Error", variant: "error" },
} as const;

type PackageAction = "enable" | "disable" | "reload";

function actionFailureMessage(action: PackageAction, error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return `The plugin could not be ${action === "reload" ? "reloaded" : `${action}d`}.`;
}

function PluginPackageRow({
  pluginPackage,
  pendingAction,
  readOnly,
  onEnabledChange,
  onReload,
}: {
  readonly pluginPackage: PluginPackageStatus;
  readonly pendingAction: PackageAction | null;
  readonly readOnly: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onReload: () => void;
}) {
  const state = statePresentation[pluginPackage.state];
  const commands = pluginPackage.contributions.commands;
  const busy = pendingAction !== null;
  const status = (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant={state.variant}>{state.label}</Badge>
      <Badge variant="outline">v{pluginPackage.version}</Badge>
      {pluginPackage.capabilities.map((capability) => (
        <Badge key={capability} variant="info">
          {capability}
        </Badge>
      ))}
    </div>
  );

  return (
    <SettingsRow
      title={<code className="text-[13px]">{pluginPackage.id}</code>}
      description={
        commands.length === 0
          ? "No command contributions"
          : `${commands.length} command${commands.length === 1 ? "" : "s"}: ${commands.join(", ")}`
      }
      status={status}
      className="border border-border/60 bg-card/35"
      control={
        <div className="flex items-center gap-2">
          {pluginPackage.enabled ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-muted"
              aria-label={`Reload ${pluginPackage.id}`}
              disabled={busy || readOnly}
              onClick={onReload}
            >
              {pendingAction === "reload" ? (
                <Spinner className="size-3.5" />
              ) : (
                <RotateCwIcon className="size-3.5" />
              )}
            </Button>
          ) : null}
          <Switch
            checked={pluginPackage.enabled}
            disabled={busy || readOnly}
            aria-label={`${pluginPackage.enabled ? "Disable" : "Enable"} ${pluginPackage.id}`}
            onCheckedChange={onEnabledChange}
          />
        </div>
      }
    >
      {pluginPackage.error ? (
        <Alert variant="error" className="mt-3">
          <CircleAlertIcon />
          <AlertDescription>{pluginPackage.error}</AlertDescription>
        </Alert>
      ) : null}
    </SettingsRow>
  );
}

export function PluginsSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const primarySession = usePrimarySessionState();
  const operateAccess = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: isElectron,
    session: primarySession.data,
    isPending: primarySession.isPending,
    hasError: primarySession.error !== null,
  });
  const readOnly = operateAccess !== "granted";
  const status = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.pluginPackages({ environmentId, input: {} }),
  );
  const enablePlugin = useAtomCommand(serverEnvironment.enablePluginPackage, {
    reportFailure: false,
  });
  const disablePlugin = useAtomCommand(serverEnvironment.disablePluginPackage, {
    reportFailure: false,
  });
  const reloadPlugin = useAtomCommand(serverEnvironment.reloadPluginPackage, {
    reportFailure: false,
  });
  const [pending, setPending] = useState<{
    readonly id: string;
    readonly action: PackageAction;
  } | null>(null);
  const packages = useMemo(
    () => [...(status.data?.packages ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
    [status.data?.packages],
  );

  const runAction = useCallback(
    (pluginPackage: PluginPackageStatus, action: PackageAction) => {
      if (environmentId === null || pending !== null || readOnly) return;
      setPending({ id: pluginPackage.id, action });
      const command =
        action === "enable" ? enablePlugin : action === "disable" ? disablePlugin : reloadPlugin;
      void (async () => {
        const result = await command({
          environmentId,
          input: { id: pluginPackage.id },
        });
        setPending(null);
        if (result._tag === "Success") {
          status.refresh();
          return;
        }
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: `Could not ${action} plugin`,
            description: actionFailureMessage(action, error),
          });
        }
      })();
    },
    [disablePlugin, enablePlugin, environmentId, pending, readOnly, reloadPlugin, status],
  );

  const countLabel = `${packages.length} ${packages.length === 1 ? "plugin" : "plugins"}`;

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("plugins")}
        headerAction={
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">{countLabel}</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label="Refresh plugins"
                    disabled={status.isPending}
                    onClick={status.refresh}
                  >
                    {status.isPending ? (
                      <Spinner className="size-3" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh plugins</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <Alert variant="warning" className="mb-3">
          <ShieldAlertIcon />
          <AlertTitle>Trusted local code</AlertTitle>
          <AlertDescription>
            Plugins run inside this environment's server process with its filesystem and network
            access. Only install code you trust.
          </AlertDescription>
        </Alert>

        {operateAccess === "denied" ? (
          <Alert variant="info" className="mb-3" data-plugin-read-only>
            <ShieldAlertIcon />
            <AlertTitle>Limited permissions</AlertTitle>
            <AlertDescription>
              This session can inspect plugins, but it cannot enable, disable, or reload them.
            </AlertDescription>
          </Alert>
        ) : null}

        {status.error ? (
          <Alert variant="error">
            <CircleAlertIcon />
            <AlertTitle>Could not load plugins</AlertTitle>
            <AlertDescription>{status.error}</AlertDescription>
          </Alert>
        ) : null}

        {status.data?.errors.map((error) => (
          <Alert
            key={error.directory}
            variant="error"
            className="mb-2"
            data-plugin-error={error.directory}
          >
            <CircleAlertIcon />
            <AlertTitle>{error.directory}</AlertTitle>
            <AlertDescription>{error.error}</AlertDescription>
          </Alert>
        ))}

        {status.isPending && status.data === null ? (
          <Empty className="min-h-52 gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Loading plugins
          </Empty>
        ) : null}

        {!status.isPending &&
        status.error === null &&
        packages.length === 0 &&
        (status.data?.errors.length ?? 0) === 0 ? (
          <Empty data-plugin-empty className="min-h-52">
            <EmptyMedia variant="icon">
              <FolderCodeIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No plugins found</EmptyTitle>
              <EmptyDescription>
                Add a trusted plugin package to this environment's userdata/plugins directory, then
                refresh this page.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        <div className="space-y-2">
          {packages.map((pluginPackage) => (
            <PluginPackageRow
              key={pluginPackage.id}
              pluginPackage={pluginPackage}
              readOnly={readOnly || pending !== null}
              pendingAction={
                pending !== null && pending.id === pluginPackage.id ? pending.action : null
              }
              onEnabledChange={(enabled) =>
                runAction(pluginPackage, enabled ? "enable" : "disable")
              }
              onReload={() => runAction(pluginPackage, "reload")}
            />
          ))}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
