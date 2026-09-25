import type { ReactElement } from "react";
import { EnvironmentId, type PluginPackageStatusSnapshot } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const environmentId = EnvironmentId.make("primary");

const atoms = vi.hoisted(() => ({
  status: Symbol("pluginPackagesStatus"),
  enable: Symbol("pluginPackagesEnable"),
  disable: Symbol("pluginPackagesDisable"),
  reload: Symbol("pluginPackagesReload"),
}));

const query = vi.hoisted(() => ({
  data: null as PluginPackageStatusSnapshot | null,
  error: null as string | null,
  isPending: false,
  refresh: vi.fn(),
}));

const commands = vi.hoisted(() => ({
  enable: vi.fn(),
  disable: vi.fn(),
  reload: vi.fn(),
}));

const access = vi.hoisted(() => ({
  value: "granted" as "granted" | "denied" | "pending",
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => environmentId,
}));

vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false }),
}));

vi.mock("../../env", () => ({ isElectron: false }));

vi.mock("./ProviderSettingsPanel.logic", () => ({
  resolvePrimaryOperateAccess: () => access.value,
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => query,
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    pluginPackages: () => atoms.status,
    enablePluginPackage: atoms.enable,
    disablePluginPackage: atoms.disable,
    reloadPluginPackage: atoms.reload,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) => {
    if (command === atoms.enable) return commands.enable;
    if (command === atoms.disable) return commands.disable;
    return commands.reload;
  },
}));

import { PluginsSettingsPanel } from "./PluginsSettings";

const snapshot: PluginPackageStatusSnapshot = {
  errors: [{ directory: "broken-package", error: "manifest is invalid" }],
  packages: [
    {
      id: "com.acme.active",
      version: "1.2.3",
      apiVersion: 1,
      enabled: true,
      state: "active",
      capabilities: ["t3.commands@1"],
      contributions: { commands: ["acme.active.run"] },
    },
    {
      id: "com.acme.disabled",
      version: "2.0.0",
      apiVersion: 1,
      enabled: false,
      state: "disabled",
      capabilities: ["t3.commands@1"],
      contributions: { commands: [] },
    },
  ],
};

function renderPanel(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return PluginsSettingsPanel() as ReactElement<Record<string, unknown>>;
}

function renderPackageRow(
  panel: ReactElement<Record<string, unknown>>,
  id: string,
): ReactElement<Record<string, unknown>> {
  const row = visitElements(
    panel,
    (element) => (element.props.pluginPackage as { readonly id?: string } | undefined)?.id === id,
  );
  expect(row).not.toBeNull();
  const render = row?.type as (
    props: Record<string, unknown>,
  ) => ReactElement<Record<string, unknown>>;
  return render(row?.props ?? {});
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("PluginsSettingsPanel", () => {
  beforeEach(() => {
    hooks.reset();
    access.value = "granted";
    query.data = snapshot;
    query.error = null;
    query.isPending = false;
    query.refresh.mockReset();
    commands.enable.mockReset().mockResolvedValue({ _tag: "Success", value: snapshot });
    commands.disable.mockReset().mockResolvedValue({ _tag: "Success", value: snapshot });
    commands.reload.mockReset().mockResolvedValue({ _tag: "Success", value: snapshot });
  });

  it("shows package state, package errors, and environment-scoped actions", () => {
    const panel = renderPanel();
    const activeRow = renderPackageRow(panel, "com.acme.active");
    const disabledRow = renderPackageRow(panel, "com.acme.disabled");

    expect(
      visitElements(
        activeRow,
        (element) => element.props["aria-label"] === "Disable com.acme.active",
      ),
    ).not.toBeNull();
    expect(
      visitElements(
        disabledRow,
        (element) => element.props["aria-label"] === "Enable com.acme.disabled",
      ),
    ).not.toBeNull();
    expect(
      visitElements(
        activeRow,
        (element) => element.props["aria-label"] === "Reload com.acme.active",
      ),
    ).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props["data-plugin-error"] === "broken-package"),
    ).not.toBeNull();
  });

  it("routes disable, enable, reload, and refresh to the primary environment", async () => {
    const panel = renderPanel();
    const activeRow = renderPackageRow(panel, "com.acme.active");
    const disabledRow = renderPackageRow(panel, "com.acme.disabled");
    const disable = visitElements(
      activeRow,
      (element) => element.props["aria-label"] === "Disable com.acme.active",
    );
    const enable = visitElements(
      disabledRow,
      (element) => element.props["aria-label"] === "Enable com.acme.disabled",
    );
    const reload = visitElements(
      activeRow,
      (element) => element.props["aria-label"] === "Reload com.acme.active",
    );
    const refresh = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Refresh plugins",
    );

    (disable?.props.onCheckedChange as ((checked: boolean) => void) | undefined)?.(false);
    (enable?.props.onCheckedChange as ((checked: boolean) => void) | undefined)?.(true);
    (reload?.props.onClick as (() => void) | undefined)?.();
    (refresh?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.disable).toHaveBeenCalledWith({
      environmentId,
      input: { id: "com.acme.active" },
    });
    expect(commands.enable).toHaveBeenCalledWith({
      environmentId,
      input: { id: "com.acme.disabled" },
    });
    expect(commands.reload).toHaveBeenCalledWith({
      environmentId,
      input: { id: "com.acme.active" },
    });
    expect(query.refresh).toHaveBeenCalledTimes(4);
  });

  it("keeps an empty environment actionable", () => {
    query.data = { packages: [], errors: [] };
    const panel = renderPanel();

    expect(
      visitElements(panel, (element) => element.props["data-plugin-empty"] === true),
    ).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props["aria-label"] === "Refresh plugins"),
    ).not.toBeNull();
  });

  it("does not claim no plugins were found when discovery reported a broken package", () => {
    query.data = {
      packages: [],
      errors: [{ directory: "broken-package", error: "manifest is invalid" }],
    };
    const panel = renderPanel();

    expect(
      visitElements(panel, (element) => element.props["data-plugin-error"] === "broken-package"),
    ).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props["data-plugin-empty"] === true),
    ).toBeNull();
  });

  it("shows package status without offering writes when the session is read only", () => {
    access.value = "denied";
    const panel = renderPanel();
    const activeRow = renderPackageRow(panel, "com.acme.active");
    const disable = visitElements(
      activeRow,
      (element) => element.props["aria-label"] === "Disable com.acme.active",
    );

    expect(disable?.props.disabled).toBe(true);
    expect(
      visitElements(panel, (element) => element.props["data-plugin-read-only"] === true),
    ).not.toBeNull();
  });

  it("disables every package action while one lifecycle mutation is pending", () => {
    commands.disable.mockReturnValue(new Promise(() => undefined));
    const panel = renderPanel();
    const activeRow = renderPackageRow(panel, "com.acme.active");
    const disable = visitElements(
      activeRow,
      (element) => element.props["aria-label"] === "Disable com.acme.active",
    );
    (disable?.props.onCheckedChange as ((checked: boolean) => void) | undefined)?.(false);

    const pendingPanel = renderPanel();
    const disabledRow = renderPackageRow(pendingPanel, "com.acme.disabled");
    const enable = visitElements(
      disabledRow,
      (element) => element.props["aria-label"] === "Enable com.acme.disabled",
    );

    expect(enable?.props.disabled).toBe(true);
  });
});
