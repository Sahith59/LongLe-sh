import type { SessionSettings } from '@longleash/protocol'
import type { AgentSettingsCatalog } from '../lib/client.js'

export type ConfigurableAgent = 'claude' | 'codex'

export interface SessionSettingsDraft {
  model: string
  customModel: string
  effort: string
  thinking: string
  thinkingBudget: string
}

export function settingsDraft(settings: SessionSettings = {}, catalogs?: AgentSettingsCatalog, agent: ConfigurableAgent = 'claude'): SessionSettingsDraft {
  const model = settings.model ?? ''
  const known = catalogs?.[agent].models ?? defaultModels(agent)
  return {
    model: model === '' || known.includes(model) ? model : '__custom__',
    customModel: model !== '' && !known.includes(model) ? model : '',
    effort: settings.effort ?? '',
    thinking: agent === 'claude' ? settings.thinking?.mode ?? '' : '',
    thinkingBudget: settings.thinking?.mode === 'fixed'
      ? String(settings.thinking.budgetTokens ?? 10_000)
      : '10000',
  }
}

export function settingsFromDraft(
  draft: SessionSettingsDraft,
  agent: ConfigurableAgent,
): { settings: SessionSettings; error?: string } {
  const model = draft.model === '__custom__' ? draft.customModel.trim() : draft.model
  if (draft.model === '__custom__' && model === '') {
    return { settings: {}, error: 'Enter the provider model ID.' }
  }
  const budget = Number(draft.thinkingBudget)
  if (
    agent === 'claude' && draft.thinking === 'fixed' &&
    (!Number.isInteger(budget) || budget < 1_024 || budget > 128_000)
  ) {
    return { settings: {}, error: 'Thinking tokens must be a whole number from 1,024 to 128,000.' }
  }
  return {
    settings: {
      ...(model === '' ? {} : { model }),
      ...(draft.effort === '' ? {} : { effort: draft.effort as SessionSettings['effort'] }),
      ...(agent !== 'claude' || draft.thinking === ''
        ? {}
        : {
            thinking: draft.thinking === 'fixed'
              ? { mode: 'fixed' as const, budgetTokens: budget }
              : { mode: draft.thinking as 'adaptive' | 'disabled' },
          }),
    },
  }
}

export function SessionSettingsFields({
  agent,
  value,
  onChange,
  catalog,
  disabled = false,
}: {
  agent: ConfigurableAgent
  value: SessionSettingsDraft
  onChange: (next: SessionSettingsDraft) => void
  catalog?: AgentSettingsCatalog
  disabled?: boolean
}) {
  const patch = (next: Partial<SessionSettingsDraft>) => onChange({ ...value, ...next })
  const models = catalog?.[agent].models ?? defaultModels(agent)
  const efforts = catalog?.[agent].efforts ?? ['low', 'medium', 'high', 'xhigh', 'max']
  return (
    <div className="settingsgrid">
      <label>
        <span>Model</span>
        <select
          value={value.model}
          disabled={disabled}
          onChange={(event) => patch({ model: event.target.value })}
        >
          <option value="">Provider default</option>
          {models.map((model) => <option key={model} value={model}>{model}</option>)}
          <option value="__custom__">Custom model ID…</option>
        </select>
      </label>
      {value.model === '__custom__' ? (
        <label>
          <span>Custom model ID</span>
          <input
            type="text"
            value={value.customModel}
            disabled={disabled}
            onChange={(event) => patch({ customModel: event.target.value })}
            placeholder={agent === 'claude' ? 'provider model alias' : 'model id'}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
      ) : null}
      <label>
        <span>Effort</span>
        <select
          value={value.effort}
          disabled={disabled}
          onChange={(event) => patch({ effort: event.target.value })}
        >
          <option value="">Provider default</option>
          {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select>
      </label>
      {agent === 'claude' ? (
        <label>
          <span>Thinking</span>
          <select
            value={value.thinking}
            disabled={disabled}
            onChange={(event) => patch({ thinking: event.target.value })}
          >
            <option value="">Provider default</option>
            <option value="adaptive">Adaptive</option>
            <option value="disabled">Off</option>
            <option value="fixed">Fixed budget</option>
          </select>
        </label>
      ) : null}
      {agent === 'claude' && value.thinking === 'fixed' ? (
        <label>
          <span>Thinking tokens</span>
          <input
            type="number"
            min={1024}
            max={128000}
            step={1024}
            inputMode="numeric"
            value={value.thinkingBudget}
            disabled={disabled}
            onChange={(event) => patch({ thinkingBudget: event.target.value })}
          />
        </label>
      ) : null}
    </div>
  )
}

function defaultModels(agent: ConfigurableAgent): string[] {
  return agent === 'claude'
    ? ['sonnet', 'opus', 'haiku']
    : ['gpt-5.6', 'gpt-5.4', 'gpt-5.3-codex']
}
