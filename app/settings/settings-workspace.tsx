'use client';

import { Button } from '@/components/ui/button';

import {
  Boxes,
  Image as ImageIcon,
  Settings2,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';

export type SettingsSectionId = 'generation' | 'quality' | 'image' | 'advanced';

type SettingsSection = {
  id: SettingsSectionId;
  title: string;
  description: string;
  children: ReactNode;
  dirty?: boolean;
};

const SECTION_ICONS: Record<SettingsSectionId, LucideIcon> = {
  generation: Boxes,
  quality: ShieldCheck,
  image: ImageIcon,
  advanced: Settings2,
};

export function SettingsWorkspace({
  sections,
  initialSection = 'generation',
  activeSection,
  onSectionChange,
}: {
  sections: SettingsSection[];
  initialSection?: SettingsSectionId;
  activeSection?: SettingsSectionId;
  onSectionChange?: (section: SettingsSectionId) => void;
}) {
  const fallback = sections.some((section) => section.id === initialSection)
    ? initialSection
    : sections[0]?.id ?? 'generation';
  const [localSection, setLocalSection] = useState<SettingsSectionId>(fallback);
  const selectedSection = activeSection ?? localSection;

  useEffect(() => {
    if (!sections.some((section) => section.id === selectedSection)) {
      setLocalSection(fallback);
      onSectionChange?.(fallback);
    }
  }, [fallback, onSectionChange, sections, selectedSection]);

  function select(section: SettingsSectionId) {
    if (activeSection === undefined) setLocalSection(section);
    onSectionChange?.(section);
  }

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % sections.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + sections.length - 1) % sections.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = sections.length - 1;
    else return;
    event.preventDefault();
    select(sections[next].id);
    document.getElementById(`settings-tab-${sections[next].id}`)?.focus();
  }

  return <div className="settings-workspace">
    <div className="settings-workspace-tabs" role="tablist" aria-label="生产配置分区">
      {sections.map((section, index) => {
        const Icon = SECTION_ICONS[section.id];
        const selected = selectedSection === section.id;
        return <Button
          unstyled
          key={section.id}
          id={`settings-tab-${section.id}`}
          className="settings-workspace-tab"
          type="button"
          role="tab"
          aria-selected={selected}
          aria-controls={`settings-panel-${section.id}`}
          tabIndex={selected ? 0 : -1}
          data-dirty={section.dirty || undefined}
          onKeyDown={(event) => navigateTabs(event, index)}
          onClick={() => select(section.id)}
        >
          <Icon size={18} aria-hidden="true" />
          <span><strong>{section.title}</strong><small>{section.description}</small></span>
          {section.dirty && <em>未保存</em>}
        </Button>;
      })}
    </div>
    {sections.map((section) => <div
      key={section.id}
      id={`settings-panel-${section.id}`}
      className="settings-workspace-panel"
      role="tabpanel"
      aria-labelledby={`settings-tab-${section.id}`}
      hidden={selectedSection !== section.id}
    >{section.children}</div>)}
  </div>;
}
