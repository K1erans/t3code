import type { PluginDataEntry, PluginDataSnapshot } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CircleAlertIcon } from "lucide-react";
import { useState } from "react";

import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { useEnvironmentOperateAccess } from "./EnvironmentIconPicker";
import {
  formatPluginDataSize,
  pluginActionErrorText,
  pluginDataDeletionLabel,
} from "./PluginsSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Every plugin's folder in the environment's `plugin-data/`. Data of a removed
 * plugin is kept for a while in case it comes back; this is where it can be
 * deleted sooner. Sizes are only measured when asked for.
 */
export function PluginDataSection({
  environment,
  showEnvironmentHint,
}: {
  readonly environment: EnvironmentPresentation;
  readonly showEnvironmentHint: boolean;
}) {
  const environmentId = environment.environmentId;
  const readOnly = useEnvironmentOperateAccess(environmentId) !== "granted";
  const query = useEnvironmentQuery(serverEnvironment.pluginData({ environmentId, input: {} }));
  const calculateSizes = useAtomCommand(serverEnvironment.calculatePluginDataSizes, {
    reportFailure: false,
  });
  const deleteData = useAtomCommand(serverEnvironment.deletePluginData, { reportFailure: false });
  const [calculating, setCalculating] = useState(false);
  const [sizes, setSizes] = useState<ReadonlyMap<string, number> | null>(null);
  const [confirming, setConfirming] = useState<PluginDataEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Actions return a fresh snapshot; hold the newest one until the query catches up.
  const [actionSnapshot, setActionSnapshot] = useState<{
    readonly snapshot: PluginDataSnapshot;
    readonly receivedAt: number;
  } | null>(null);
  const snapshot =
    actionSnapshot !== null && actionSnapshot.receivedAt > (query.dataUpdatedAt ?? 0)
      ? actionSnapshot.snapshot
      : query.data;
  const entries = snapshot?.entries ?? [];
  // Countdowns are whole days, so the time the page opened is precise enough.
  const [now] = useState(Date.now);

  const runCalculate = () => {
    if (calculating) return;
    setCalculating(true);
    void (async () => {
      const result = await calculateSizes({ environmentId, input: {} });
      setCalculating(false);
      if (result._tag === "Success") {
        setActionSnapshot({ snapshot: result.value, receivedAt: Date.now() });
        setSizes(new Map(result.value.entries.map((entry) => [entry.id, entry.sizeBytes ?? 0])));
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not calculate plugin data sizes",
          description:
            pluginActionErrorText(squashAtomCommandFailure(result)) ??
            "The plugin data folder could not be read.",
        });
      }
    })();
  };

  const runDelete = (entry: PluginDataEntry) => {
    if (deleting || readOnly) return;
    setDeleting(true);
    void (async () => {
      const result = await deleteData({ environmentId, input: { id: entry.id } });
      setDeleting(false);
      setConfirming(null);
      if (result._tag === "Success") {
        setActionSnapshot({ snapshot: result.value, receivedAt: Date.now() });
        return;
      }
      query.refresh();
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: `Could not delete data for ${entry.id}`,
          description:
            pluginActionErrorText(squashAtomCommandFailure(result)) ??
            "The plugin data folder could not be deleted.",
        });
      }
    })();
  };

  return (
    <SettingsSection
      {...searchableSetting("storage-plugin-data")}
      headerAction={
        entries.length > 0 ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={calculating}
            onClick={runCalculate}
          >
            {calculating ? <Spinner className="size-3" /> : null}
            Calculate sizes
          </Button>
        ) : null
      }
    >
      {showEnvironmentHint ? (
        <p className="mb-3 text-sm text-muted-foreground">
          Showing plugin data on {environment.label}. Choose an environment above to manage another.
        </p>
      ) : null}

      {query.error ? (
        <Alert variant="error">
          <CircleAlertIcon />
          <AlertTitle>Could not load plugin data</AlertTitle>
          <AlertDescription>{query.error}</AlertDescription>
        </Alert>
      ) : null}

      {query.isPending && snapshot === null ? (
        <Empty size="compact">
          <Spinner className="size-4" />
          <EmptyDescription>Loading plugin data</EmptyDescription>
        </Empty>
      ) : null}

      {!query.isPending && query.error === null && entries.length === 0 ? (
        <Empty size="compact">
          <EmptyDescription>No plugins have stored data on {environment.label}.</EmptyDescription>
        </Empty>
      ) : null}

      {entries.map((entry) => {
        const size = sizes?.get(entry.id);
        return (
          <SettingsRow
            key={entry.id}
            title={entry.name ?? entry.id}
            description={
              <>
                {entry.name ? <span className="block font-mono text-xs">{entry.id}</span> : null}
                {entry.installed
                  ? "Kept while the plugin is installed, including when it is disabled."
                  : "The plugin is no longer installed. Reinstalling it keeps this data."}
              </>
            }
            status={
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={entry.installed ? "secondary" : "warning"}>
                  {entry.installed ? "Installed" : "Not installed"}
                </Badge>
                {!entry.installed && entry.deletesAt !== undefined ? (
                  <span className="text-xs text-muted-foreground">
                    {pluginDataDeletionLabel(entry.deletesAt, now)}
                  </span>
                ) : null}
              </div>
            }
            control={
              <div className="flex items-center gap-3">
                {size !== undefined ? (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatPluginDataSize(size)}
                  </span>
                ) : null}
                {entry.installed ? null : (
                  <Button
                    type="button"
                    size="xs"
                    variant="destructive-outline"
                    disabled={readOnly || deleting}
                    onClick={() => setConfirming(entry)}
                  >
                    Delete data
                  </Button>
                )}
              </div>
            }
          />
        );
      })}

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setConfirming(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete data for {confirming?.id}?</AlertDialogTitle>
            <AlertDialogDescription>
              Everything this plugin saved on {environment.label} is deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={deleting}
              render={<Button variant="outline" disabled={deleting} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={deleting || confirming === null}
              onClick={() => {
                if (confirming !== null) runDelete(confirming);
              }}
            >
              {deleting ? <Spinner size="sm" /> : null}
              Delete data
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
