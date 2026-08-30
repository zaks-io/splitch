export type SettingsTab = "app" | "environment";

const TABS = [
  { tab: "app", label: "App", href: "" },
  { tab: "environment", label: "Environment", href: "/environment" },
] as const;

/**
 * The Settings section is split exactly the way the IA pins it: App-level
 * identity, access, and catalog on one side; the active Environment's
 * credentials and Policy on the other. Same tab treatment as Experiment detail.
 */
export function SettingsTabs({
  activeTab,
  baseHref,
}: {
  activeTab: SettingsTab;
  baseHref: string;
}) {
  return (
    <nav aria-label="Settings tabs" className="flex gap-1 border-border border-b">
      {TABS.map(({ tab, label, href }) => (
        <a
          aria-current={activeTab === tab ? "page" : undefined}
          className={`border-b-2 px-4 py-2.5 font-medium text-sm ${
            activeTab === tab
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          data-settings-tab={tab}
          href={`${baseHref}${href}`}
          key={tab}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}
