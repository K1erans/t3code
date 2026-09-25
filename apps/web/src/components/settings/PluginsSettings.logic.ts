import type { PluginPackageStatus } from "@t3tools/contracts";

export interface PluginStatusBadge {
  readonly label: string;
  readonly variant: "success" | "secondary" | "error" | "warning";
}

const STATE_BADGES: Record<PluginPackageStatus["state"], PluginStatusBadge> = {
  active: { label: "Active", variant: "success" },
  idle: { label: "Idle", variant: "secondary" },
  disabled: { label: "Disabled", variant: "secondary" },
  error: { label: "Error", variant: "error" },
};

/** The state badge plus API-compatibility warnings, in display order. */
export function pluginStatusBadges(
  pluginPackage: Pick<PluginPackageStatus, "state" | "requires" | "olderApiRemovedIn">,
): PluginStatusBadge[] {
  const badges = [STATE_BADGES[pluginPackage.state]];
  if (pluginPackage.requires.some((capability) => capability.endsWith("@0"))) {
    badges.push({ label: "Experimental API", variant: "warning" });
  }
  if (pluginPackage.olderApiRemovedIn !== undefined) {
    badges.push({
      label: `Older API, stops working in T3 ${pluginPackage.olderApiRemovedIn}`,
      variant: "warning",
    });
  }
  return badges;
}

/** Case-insensitive match of every whitespace-separated term against name, id and description. */
export function filterPluginPackages<
  T extends Pick<PluginPackageStatus, "id" | "name" | "description">,
>(packages: readonly T[], query: string): readonly T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return packages;
  return packages.filter((pluginPackage) => {
    const haystack =
      `${pluginPackage.name}\n${pluginPackage.id}\n${pluginPackage.description ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
