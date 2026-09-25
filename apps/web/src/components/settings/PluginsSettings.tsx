import type { PluginPackageStatus } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CircleAlertIcon,
  FolderCodeIcon,
  PackageIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SearchIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useEnvironmentOperateAccess } from "./EnvironmentIconPicker";
import { filterPluginPackages, pluginStatusBadges } from "./PluginsSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

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
  const busy = pendingAction !== null;
  const status = (
    <div className="flex flex-wrap items-center gap-1.5">
      {pluginStatusBadges(pluginPackage).map((badge) => (
        <Badge key={badge.label} variant={badge.variant}>
          {badge.label}
        </Badge>
      ))}
    </div>
  );

  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          {pluginPackage.iconUrl ? (
            <img src={pluginPackage.iconUrl} alt="" className="size-4 shrink-0" />
          ) : (
            <PackageIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate">{pluginPackage.name}</span>
        </span>
      }
      description={
        <>
          {pluginPackage.description ? (
            <span className="block">{pluginPackage.description}</span>
          ) : null}
          <span className="block font-mono text-xs">
            {pluginPackage.id} · v{pluginPackage.version}
          </span>
        </>
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
              aria-label={`Reload ${pluginPackage.name}`}
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
            aria-label={`${pluginPackage.enabled ? "Disable" : "Enable"} ${pluginPackage.name}`}
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

/**
 * Plugins installed on the environment picked in the settings scope. Install
 * and enable state live on that environment, so every client sees the same list.
 */
export function PluginsSettingsPanel() {
  const { environment, connectedEnvironments, scope } = useSettingsScope();
  if (environment === null) {
    return (
      <SettingsScopeNotice target="environment">
        Connect an environment to manage its plugins.
      </SettingsScopeNotice>
    );
  }
  return (
    <EnvironmentPluginsSettings
      key={environment.environmentId}
      environment={environment}
      // With several environments selected, name the one shown rather than imply all of them.
      showEnvironmentHint={scope.kind !== "environment" && connectedEnvironments.length > 1}
    />
  );
}

function EnvironmentPluginsSettings({
  environment,
  showEnvironmentHint,
}: {
  readonly environment: EnvironmentPresentation;
  readonly showEnvironmentHint: boolean;
}) {
  const environmentId = environment.environmentId;
  const operateAccess = useEnvironmentOperateAccess(environmentId);
  const readOnly = operateAccess !== "granted";
  const status = useEnvironmentQuery(
    serverEnvironment.pluginPackages({ environmentId, input: {} }),
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
  const rescanPlugins = useAtomCommand(serverEnvironment.rescanPluginPackages, {
    reportFailure: false,
  });
  const [rescanning, setRescanning] = useState(false);
  const [pending, setPending] = useState<{
    readonly id: string;
    readonly action: PackageAction;
  } | null>(null);
  const [query, setQuery] = useState("");
  const packages = useMemo(
    () =>
      [...(status.data?.packages ?? [])].sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      ),
    [status.data?.packages],
  );
  const visiblePackages = useMemo(() => filterPluginPackages(packages, query), [packages, query]);
  const discoveryErrors = status.data?.errors ?? [];

  const runAction = useCallback(
    (pluginPackage: PluginPackageStatus, action: PackageAction) => {
      if (pending !== null || readOnly) return;
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
            title: `Could not ${action} ${pluginPackage.name}`,
            description: actionFailureMessage(action, error),
          });
        }
      })();
    },
    [disablePlugin, enablePlugin, environmentId, pending, readOnly, reloadPlugin, status],
  );

  // Rescan reloads changed plugins, which needs operate access; a read-only
  // session still re-reads the status, which re-discovers the folder.
  const rescan = useCallback(() => {
    if (rescanning) return;
    if (readOnly) {
      status.refresh();
      return;
    }
    setRescanning(true);
    void (async () => {
      const result = await rescanPlugins({ environmentId, input: {} });
      setRescanning(false);
      status.refresh();
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not rescan plugins",
          description:
            error instanceof Error ? error.message : "The plugins folder could not be read.",
        });
      }
    })();
  }, [environmentId, readOnly, rescanPlugins, rescanning, status]);

  const countLabel = `${packages.length} ${packages.length === 1 ? "plugin" : "plugins"}`;

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("plugins")}
        headerAction={
          <div className="flex items-center gap-2">
            <span className="text-2xs text-muted-foreground">{countLabel}</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label="Rescan plugins"
                    disabled={status.isPending || rescanning}
                    onClick={rescan}
                  >
                    {status.isPending || rescanning ? (
                      <Spinner className="size-3" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">Rescan plugins</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {showEnvironmentHint ? (
          <p className="mb-3 text-sm text-muted-foreground">
            Showing plugins on {environment.label}. Choose an environment above to manage another.
          </p>
        ) : null}

        <Alert variant="warning" className="mb-3">
          <ShieldAlertIcon />
          <AlertTitle>Trusted local code</AlertTitle>
          <AlertDescription>
            Plugins run inside this environment's server process with its filesystem and network
            access. Only install code you trust.
          </AlertDescription>
        </Alert>

        {operateAccess === "denied" ? (
          <Alert variant="info" className="mb-3">
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

        {status.isPending && status.data === null ? (
          <Empty size="compact">
            <Spinner className="size-4" />
            <EmptyDescription>Loading plugins</EmptyDescription>
          </Empty>
        ) : null}

        {!status.isPending &&
        status.error === null &&
        packages.length === 0 &&
        discoveryErrors.length === 0 ? (
          <Empty size="compact">
            <EmptyMedia variant="icon">
              <FolderCodeIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No plugins on {environment.label}</EmptyTitle>
              <EmptyDescription>
                Install one by running <code>t3 plugin install &lt;folder&gt;</code> on that
                machine, then rescan.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {packages.length > 0 ? (
          <InputGroup className="mb-3">
            <InputGroupAddon>
              <SearchIcon aria-hidden className="size-3" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search plugins"
              aria-label="Search plugins"
              size="sm"
            />
          </InputGroup>
        ) : null}

        {packages.length > 0 && visiblePackages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No plugins match “{query.trim()}”.</p>
        ) : null}

        <div className="space-y-2">
          {visiblePackages.map((pluginPackage) => (
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

      {discoveryErrors.length > 0 ? (
        <SettingsSection title="Discovery errors">
          <div className="space-y-2">
            {discoveryErrors.map((error) => (
              <Alert key={error.directory} variant="error">
                <CircleAlertIcon />
                <AlertTitle>{error.directory}</AlertTitle>
                <AlertDescription>{error.error}</AlertDescription>
              </Alert>
            ))}
          </div>
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
