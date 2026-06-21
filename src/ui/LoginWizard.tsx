// /login 交互式配置向导 — 分步选择 provider → model → API Key
import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from './TextInput'
import type { Provider } from '../config'
import { t } from '../i18n'

const INDIGO = '#6A5ACD'
const SILVER = '#C8D8FF'
const DIM = '#7A8AAA'
const GREEN = '#5AF78E'

// ─── 数据 ────────────────────────────────────────────────────────────────────

interface ProviderOption {
  label: string
  value: Exclude<Provider, 'ollama'>
  hint: string
}

const PROVIDERS: ProviderOption[] = [
  { label: 'Anthropic', value: 'anthropic', hint: 'claude-opus / sonnet / haiku' },
  { label: 'DeepSeek', value: 'deepseek', hint: 'V4 chat · R1 reasoning' },
  { label: 'Kimi (Moonshot)', value: 'kimi', hint: 'kimi-k2 · 256K context' },
  { label: 'OpenAI (GPT)', value: 'openai', hint: 'gpt-5.5 · gpt-5.4 · o3' },
]

interface ModelOption { label: string; value: string; hint: string }

// hint 存 i18n key（运行时 t() 解析），不存翻译文本。
const MODELS: Record<Exclude<Provider, 'ollama'>, ModelOption[]> = {
  anthropic: [
    { label: 'claude-opus-4-7', value: 'claude-opus-4-7', hint: 'mStrongest' },
    { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6', hint: 'mRecommended' },
    { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5-20251001', hint: 'mFast' },
  ],
  deepseek: [
    { label: 'deepseek-chat', value: 'deepseek-chat', hint: 'mDsChat' },
    { label: 'deepseek-reasoner', value: 'deepseek-reasoner', hint: 'mDsReasoner' },
  ],
  kimi: [
    { label: 'kimi-k2-0905-preview', value: 'kimi-k2-0905-preview', hint: 'mKimiK2' },
    { label: 'kimi-k2-turbo-preview', value: 'kimi-k2-turbo-preview', hint: 'mKimiTurbo' },
    { label: 'kimi-latest', value: 'kimi-latest', hint: 'mKimiLatest' },
    { label: 'moonshot-v1-128k', value: 'moonshot-v1-128k', hint: 'mMoonshot128' },
  ],
  openai: [
    { label: 'gpt-5.5', value: 'gpt-5.5', hint: 'mGpt55' },
    { label: 'gpt-5.4', value: 'gpt-5.4', hint: 'mGpt54' },
    { label: 'gpt-5.4-mini', value: 'gpt-5.4-mini', hint: 'mGpt54mini' },
    { label: 'gpt-4o', value: 'gpt-4o', hint: 'mGpt4o' },
    { label: 'o3', value: 'o3', hint: 'mO3' },
  ],
}

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface LoginResult {
  provider: Exclude<Provider, 'ollama'>
  model: string
  apiKey: string
}

interface Props {
  onDone: (result: LoginResult | null) => void
}

type Step = 'provider' | 'model' | 'apikey'

// ─── 子组件：列表选择行 ────────────────────────────────────────────────────────

function ListRow({ label, hint, active }: { label: string; hint: string; active: boolean }) {
  return (
    <Box>
      <Text color={active ? INDIGO : DIM}>{active ? '❯ ' : '  '}</Text>
      <Text color={active ? SILVER : DIM} bold={active}>{label.padEnd(22)}</Text>
      <Text color={DIM}>{hint}</Text>
    </Box>
  )
}

// ─── 向导主体 ─────────────────────────────────────────────────────────────────

export function LoginWizard({ onDone }: Props): React.ReactNode {
  const [step, setStep] = useState<Step>('provider')
  const [providerIdx, setProviderIdx] = useState(0)
  const [modelIdx, setModelIdx] = useState(0)
  const [provider, setProvider] = useState<Exclude<Provider, 'ollama'>>('anthropic')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')

  const models = MODELS[provider]
  const providerLabel = PROVIDERS.find(p => p.value === provider)?.label ?? provider

  useInput((_, key) => {
    // ESC 始终取消
    if (key.escape) {
      onDone(null)
      return
    }

    // apikey 步骤：只处理 ESC，其余交给 TextInput
    if (step === 'apikey') return

    if (key.upArrow) {
      if (step === 'provider') setProviderIdx(i => Math.max(0, i - 1))
      else setModelIdx(i => Math.max(0, i - 1))
    } else if (key.downArrow) {
      if (step === 'provider') setProviderIdx(i => Math.min(PROVIDERS.length - 1, i + 1))
      else setModelIdx(i => Math.min(models.length - 1, i + 1))
    } else if (key.return) {
      if (step === 'provider') {
        const chosen = PROVIDERS[providerIdx]!
        setProvider(chosen.value)
        setModelIdx(0)
        setStep('model')
      } else if (step === 'model') {
        setModel(models[modelIdx]!.value)
        setStep('apikey')
      }
    }
  })

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={INDIGO}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
      width={62}
    >
      {/* 标题 */}
      <Box marginBottom={1}>
        <Text color={INDIGO} bold>✦ </Text>
        <Text color={SILVER} bold>Astraea /login</Text>
        <Text color={DIM}> {t('loginTitleSuffix')}</Text>
      </Box>

      {/* Step 1: 选择 Provider */}
      {step === 'provider' && (
        <>
          <Text color={SILVER}>{t('loginSelectProvider')}</Text>
          <Box flexDirection="column" marginY={1}>
            {PROVIDERS.map((p, i) => (
              <ListRow key={p.value} label={p.label} hint={p.hint} active={i === providerIdx} />
            ))}
          </Box>
          <Text color={DIM}>{t('navHint')}</Text>
        </>
      )}

      {/* Step 2: 选择 Model */}
      {step === 'model' && (
        <>
          <Box>
            <Text color={DIM}>{t('labelProvider')} </Text>
            <Text color={SILVER}>{providerLabel}</Text>
          </Box>
          <Text color={SILVER}>{t('loginSelectModel')}</Text>
          <Box flexDirection="column" marginY={1}>
            {models.map((m, i) => (
              <ListRow key={m.value} label={m.label} hint={t(m.hint)} active={i === modelIdx} />
            ))}
          </Box>
          <Text color={DIM}>{t('navHint')}</Text>
        </>
      )}

      {/* Step 3: 输入 API Key */}
      {step === 'apikey' && (
        <>
          <Box>
            <Text color={DIM}>{'Provider:  '}</Text>
            <Text color={SILVER}>{providerLabel}</Text>
          </Box>
          <Box marginBottom={1}>
            <Text color={DIM}>{'Model:     '}</Text>
            <Text color={SILVER}>{model}</Text>
          </Box>
          <Box>
            <Text color={SILVER}>{'API Key:   '}</Text>
            <TextInput
              value={apiKey}
              onChange={setApiKey}
              mask="*"
              enablePaste
              placeholder={t('loginApiKeyPlaceholder')}
              onSubmit={(val) => {
                if (val.trim()) onDone({ provider, model, apiKey: val.trim() })
              }}
            />
          </Box>
          <Box marginTop={1}>
            <Text color={DIM}>{t('saveHint')}</Text>
          </Box>
        </>
      )}
    </Box>
  )
}

// ─── 成功提示（在历史中显示） ─────────────────────────────────────────────────

export function formatLoginSuccess(result: LoginResult): string {
  const masked = result.apiKey.length > 8
    ? result.apiKey.slice(0, 4) + '***' + result.apiKey.slice(-4)
    : '***'
  return `✓ ${t('loginSavedTitle')}\n  Provider: ${result.provider}\n  Model:    ${result.model}\n  API Key:  ${masked}`
}
