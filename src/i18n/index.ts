// 轻量 i18n —— 模块单例 + 字符串目录，覆盖「少量高频 UI」（设计见 /grill-me 讨论）。
// 风格对齐 config / sessionMode 的模块单例：组件 import { t }，App 在切换时
// setLocale() + bump configVersion（重渲 live 区）+ wipeStatic（重渲 Static/welcome）。
//
// 持久化：仅在用户显式 /language 选择时写入 settings.json.language；
// 未设置则每次启动按系统 locale 探测（不冻结）。
import { getSettings } from '../settings'

export type Locale = 'en' | 'de' | 'fr' | 'es' | 'zh' | 'ko'

export interface LocaleMeta {
  id: Locale
  nativeName: string   // 选择器里显示的本地语言名
  replyName: string    // 注入系统提示「Always respond in X」用的英文语言名
}

export const LOCALES: LocaleMeta[] = [
  { id: 'en', nativeName: 'English',  replyName: 'English' },
  { id: 'de', nativeName: 'Deutsch',  replyName: 'German' },
  { id: 'fr', nativeName: 'Français', replyName: 'French' },
  { id: 'es', nativeName: 'Español',  replyName: 'Spanish' },
  { id: 'zh', nativeName: '中文',      replyName: 'Chinese' },
  { id: 'ko', nativeName: '한국어',    replyName: 'Korean' },
]

const SUPPORTED = new Set<string>(LOCALES.map(l => l.id))

// ─── 系统 locale 探测 ─────────────────────────────────────────────────────────
// Intl 在三端（mac/Linux/Windows）都返回 BCP-47（如 "en-US" / "zh-CN"）；
// 退回 LANG/LC_* 环境变量。取主语言子标签映射到受支持集合，否则英文兜底。
export function detectLocale(): Locale {
  let raw = ''
  try { raw = Intl.DateTimeFormat().resolvedOptions().locale || '' } catch { /* ignore */ }
  if (!raw) raw = process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || ''
  const prefix = raw.toLowerCase().split(/[-_.]/)[0] ?? ''
  return SUPPORTED.has(prefix) ? (prefix as Locale) : 'en'
}

// ─── 当前 locale（模块单例）────────────────────────────────────────────────────
function initialLocale(): Locale {
  const fromSettings = getSettings().language
  if (fromSettings && SUPPORTED.has(fromSettings)) return fromSettings as Locale
  return detectLocale()
}

let _locale: Locale = initialLocale()

export function getLocale(): Locale { return _locale }
export function setLocale(locale: Locale): void { _locale = locale }

/** 当前 locale 对应、注入系统提示词的回复语言名（如 "Chinese"）。 */
export function replyLanguageName(): string {
  return LOCALES.find(l => l.id === _locale)?.replyName ?? 'English'
}

// ─── 字符串目录 ────────────────────────────────────────────────────────────────
// key 为稳定标识；缺失时回退英文，再回退 key 本身。{name} 占位由 t() 第二参替换。
type Dict = Record<string, string>

const EN: Dict = {
  // 通用导航
  navHint: '↑↓ move  Enter confirm  Esc cancel',
  saveHint: 'Enter save  Esc cancel',
  labelProvider: 'Provider:',
  labelModel: 'Model:',
  labelApiKey: 'API Key:',
  // Welcome 卡片
  wEpithet: 'Goddess of the Stars',
  wTagline1: 'You speak, I understand · You imagine, I assist · You build, I\'m here.',
  wTagline2: 'Order is not constraint — it\'s the foundation of freedom.',
  wTagline3: 'Building a better life, together.',
  wModel: 'model',
  wDir: 'dir',
  wTools: 'tools',
  wFooter: 'message · Ctrl+C exit',
  // /login 向导
  loginTitleSuffix: '— configure provider',
  loginSelectProvider: 'Select provider:',
  loginSelectModel: 'Select model:',
  loginApiKeyPlaceholder: 'type then press Enter to save (paste supported)...',
  loginSavedTitle: 'Configuration saved',
  // /internet 向导
  netTitleSuffix: '— configure web search',
  netCurrent: 'Current: ',
  netConfigured: ' (configured)',
  netNotConfigured: 'not configured — web search unavailable',
  netSelect: 'Select a search provider:',
  netGetKey: 'Get key:  ',
  netApiKeyPlaceholder: 'paste API key then press Enter to save...',
  netSavedTitle: 'Web search configured',
  netSavedHint: 'Saved to ~/.astraea/.env (applies to all projects). I can search the web now.',
  // /language 向导
  langTitleSuffix: '— choose language',
  langSelect: 'Select UI & reply language:',
  langSavedTitle: 'Language switched',
  // 搜索 provider 提示（/internet）
  provHintBocha: 'China-direct · built for AI · recommended',
  provHintZhipu: 'China-direct · reuse Zhipu key',
  provHintTavily: '1,000/mo · proxy needed',
  provHintBrave: '2,000/mo · proxy needed',
  provHintExa: 'semantic search · proxy needed',
  // 模型提示（/login）
  mStrongest: 'most capable',
  mRecommended: 'recommended',
  mFast: 'fast',
  mDsChat: 'V4/V3 latest',
  mDsReasoner: 'R1 reasoning',
  mGpt55: 'most capable · 128K output',
  mGpt54: 'recommended · value',
  mGpt54mini: 'fast · subtasks',
  mGpt4o: 'legacy · balanced',
  mO3: 'legacy · reasoning',
  // /help
  helpCommands: 'Commands',
  helpSkills: 'Skills',
  // 杂项
  todoAllDone: 'All tasks complete',
  todoPaused: 'paused — {n} task(s) still open',
  todoAllDoneN: 'All {n} task(s) complete',
  turnLimit: '⚠ Reached the {n}-turn limit; the task may be unfinished. Press Enter or say "continue" to keep going.',
}

const ZH: Dict = {
  navHint: '↑↓ 移动  Enter 确认  Esc 取消',
  saveHint: 'Enter 保存  Esc 取消',
  labelProvider: 'Provider:',
  labelModel: 'Model:',
  labelApiKey: 'API Key:',
  wEpithet: '星之女神',
  wTagline1: '你说，我懂 · 你想，我助 · 你造，我在。',
  wTagline2: '秩序不是束缚——它是自由的根基。',
  wTagline3: '一起，把生活建得更好。',
  wModel: '模型',
  wDir: '目录',
  wTools: '工具',
  wFooter: '输入消息 · Ctrl+C 退出',
  loginTitleSuffix: '— 配置 Provider',
  loginSelectProvider: '选择 Provider:',
  loginSelectModel: '选择 Model:',
  loginApiKeyPlaceholder: '输入后按 Enter 保存（支持粘贴）...',
  loginSavedTitle: '配置已保存',
  netTitleSuffix: '— 配置联网搜索',
  netCurrent: '当前: ',
  netConfigured: '（已配置）',
  netNotConfigured: '未配置 — 联网搜索不可用',
  netSelect: '选择搜索 Provider:',
  netGetKey: '获取 Key:  ',
  netApiKeyPlaceholder: '粘贴 API Key 后按 Enter 保存...',
  netSavedTitle: '联网搜索已配置',
  netSavedHint: '已保存到 ~/.astraea/.env，所有项目生效。现在可以让我联网搜索了。',
  langTitleSuffix: '— 选择语言',
  langSelect: '选择界面与回复语言:',
  langSavedTitle: '语言已切换',
  provHintBocha: '国内直连 · 专为 AI 设计 · 推荐',
  provHintZhipu: '国内直连 · 可复用智谱 Key',
  provHintTavily: '1,000次/月 · 需代理',
  provHintBrave: '2,000次/月 · 需代理',
  provHintExa: '语义搜索 · 需代理',
  mStrongest: '最强',
  mRecommended: '推荐',
  mFast: '快速',
  mDsChat: 'V4/V3 最新',
  mDsReasoner: 'R1 推理',
  mGpt55: '最强 · 128K 输出',
  mGpt54: '推荐 · 性价比',
  mGpt54mini: '快速 · 子任务',
  mGpt4o: '旧 · 均衡',
  mO3: '旧 · 推理',
  helpCommands: '命令',
  helpSkills: '技能',
  todoAllDone: '所有任务已完成',
  todoPaused: '已暂停 — 还有 {n} 个任务未完成',
  todoAllDoneN: '已完成全部 {n} 个任务',
  turnLimit: '⚠ 已达单轮上限 {n} 轮，任务可能未完成。直接回车或补一句"继续"即可接着跑。',
}

const DE: Dict = {
  navHint: '↑↓ bewegen  Enter bestätigen  Esc abbrechen',
  saveHint: 'Enter speichern  Esc abbrechen',
  labelProvider: 'Anbieter:',
  labelModel: 'Modell:',
  labelApiKey: 'API-Schlüssel:',
  wEpithet: 'Göttin der Sterne',
  wTagline1: 'Du sprichst, ich verstehe · Du träumst, ich helfe · Du baust, ich bin da.',
  wTagline2: 'Ordnung ist kein Zwang — sie ist das Fundament der Freiheit.',
  wTagline3: 'Gemeinsam ein besseres Leben gestalten.',
  wModel: 'Modell',
  wDir: 'Verz.',
  wTools: 'Tools',
  wFooter: 'Nachricht · Ctrl+C beenden',
  loginTitleSuffix: '— Anbieter konfigurieren',
  loginSelectProvider: 'Anbieter wählen:',
  loginSelectModel: 'Modell wählen:',
  loginApiKeyPlaceholder: 'eingeben, dann Enter zum Speichern (Einfügen möglich)...',
  loginSavedTitle: 'Konfiguration gespeichert',
  netTitleSuffix: '— Websuche konfigurieren',
  netCurrent: 'Aktuell: ',
  netConfigured: ' (konfiguriert)',
  netNotConfigured: 'nicht konfiguriert — Websuche nicht verfügbar',
  netSelect: 'Suchanbieter wählen:',
  netGetKey: 'Schlüssel: ',
  netApiKeyPlaceholder: 'API-Schlüssel einfügen, dann Enter zum Speichern...',
  netSavedTitle: 'Websuche konfiguriert',
  netSavedHint: 'In ~/.astraea/.env gespeichert (gilt für alle Projekte). Ich kann jetzt im Web suchen.',
  langTitleSuffix: '— Sprache wählen',
  langSelect: 'UI- und Antwortsprache wählen:',
  langSavedTitle: 'Sprache gewechselt',
  provHintBocha: 'China-direkt · für KI gebaut · empfohlen',
  provHintZhipu: 'China-direkt · Zhipu-Key wiederverwenden',
  provHintTavily: '1.000/Mon · Proxy nötig',
  provHintBrave: '2.000/Mon · Proxy nötig',
  provHintExa: 'semantische Suche · Proxy nötig',
  helpCommands: 'Befehle',
  helpSkills: 'Skills',
  todoAllDone: 'Alle Aufgaben erledigt',
  todoPaused: 'pausiert — {n} Aufgabe(n) noch offen',
  todoAllDoneN: 'Alle {n} Aufgabe(n) erledigt',
  turnLimit: '⚠ {n}-Runden-Limit erreicht; die Aufgabe ist evtl. unvollständig. Enter drücken oder „weiter" sagen, um fortzufahren.',
}

const FR: Dict = {
  navHint: '↑↓ déplacer  Entrée confirmer  Échap annuler',
  saveHint: 'Entrée enregistrer  Échap annuler',
  labelProvider: 'Fournisseur :',
  labelModel: 'Modèle :',
  labelApiKey: 'Clé API :',
  wEpithet: 'Déesse des étoiles',
  wTagline1: 'Tu parles, je comprends · Tu imagines, j\'assiste · Tu construis, je suis là.',
  wTagline2: 'L\'ordre n\'est pas une contrainte — c\'est le fondement de la liberté.',
  wTagline3: 'Construire une vie meilleure, ensemble.',
  wModel: 'modèle',
  wDir: 'dossier',
  wTools: 'outils',
  wFooter: 'message · Ctrl+C quitter',
  loginTitleSuffix: '— configurer le fournisseur',
  loginSelectProvider: 'Choisir le fournisseur :',
  loginSelectModel: 'Choisir le modèle :',
  loginApiKeyPlaceholder: 'saisir puis Entrée pour enregistrer (collage possible)...',
  loginSavedTitle: 'Configuration enregistrée',
  netTitleSuffix: '— configurer la recherche web',
  netCurrent: 'Actuel : ',
  netConfigured: ' (configuré)',
  netNotConfigured: 'non configuré — recherche web indisponible',
  netSelect: 'Choisir un fournisseur de recherche :',
  netGetKey: 'Obtenir : ',
  netApiKeyPlaceholder: 'collez la clé API puis Entrée pour enregistrer...',
  netSavedTitle: 'Recherche web configurée',
  netSavedHint: 'Enregistré dans ~/.astraea/.env (vaut pour tous les projets). Je peux chercher sur le web.',
  langTitleSuffix: '— choisir la langue',
  langSelect: 'Choisir la langue de l\'UI et des réponses :',
  langSavedTitle: 'Langue changée',
  provHintBocha: 'Chine-direct · conçu pour l\'IA · recommandé',
  provHintZhipu: 'Chine-direct · réutiliser la clé Zhipu',
  provHintTavily: '1 000/mois · proxy requis',
  provHintBrave: '2 000/mois · proxy requis',
  provHintExa: 'recherche sémantique · proxy requis',
  helpCommands: 'Commandes',
  helpSkills: 'Compétences',
  todoAllDone: 'Toutes les tâches terminées',
  todoPaused: 'en pause — {n} tâche(s) encore ouverte(s)',
  todoAllDoneN: 'Les {n} tâche(s) terminées',
  turnLimit: '⚠ Limite de {n} tours atteinte ; la tâche est peut-être inachevée. Appuyez sur Entrée ou dites « continuer ».',
}

const ES: Dict = {
  navHint: '↑↓ mover  Enter confirmar  Esc cancelar',
  saveHint: 'Enter guardar  Esc cancelar',
  labelProvider: 'Proveedor:',
  labelModel: 'Modelo:',
  labelApiKey: 'Clave API:',
  wEpithet: 'Diosa de las estrellas',
  wTagline1: 'Tú hablas, yo entiendo · Tú imaginas, yo ayudo · Tú creas, yo estoy aquí.',
  wTagline2: 'El orden no es una atadura — es la base de la libertad.',
  wTagline3: 'Construyendo juntos una vida mejor.',
  wModel: 'modelo',
  wDir: 'dir',
  wTools: 'herram.',
  wFooter: 'mensaje · Ctrl+C salir',
  loginTitleSuffix: '— configurar proveedor',
  loginSelectProvider: 'Elegir proveedor:',
  loginSelectModel: 'Elegir modelo:',
  loginApiKeyPlaceholder: 'escribe y pulsa Enter para guardar (pegar permitido)...',
  loginSavedTitle: 'Configuración guardada',
  netTitleSuffix: '— configurar búsqueda web',
  netCurrent: 'Actual: ',
  netConfigured: ' (configurado)',
  netNotConfigured: 'sin configurar — búsqueda web no disponible',
  netSelect: 'Elegir un proveedor de búsqueda:',
  netGetKey: 'Obtener: ',
  netApiKeyPlaceholder: 'pega la clave API y pulsa Enter para guardar...',
  netSavedTitle: 'Búsqueda web configurada',
  netSavedHint: 'Guardado en ~/.astraea/.env (aplica a todos los proyectos). Ya puedo buscar en la web.',
  langTitleSuffix: '— elegir idioma',
  langSelect: 'Elegir idioma de la interfaz y respuestas:',
  langSavedTitle: 'Idioma cambiado',
  provHintBocha: 'China-directo · hecho para IA · recomendado',
  provHintZhipu: 'China-directo · reutiliza clave Zhipu',
  provHintTavily: '1.000/mes · requiere proxy',
  provHintBrave: '2.000/mes · requiere proxy',
  provHintExa: 'búsqueda semántica · requiere proxy',
  helpCommands: 'Comandos',
  helpSkills: 'Habilidades',
  todoAllDone: 'Todas las tareas completadas',
  todoPaused: 'en pausa — {n} tarea(s) aún abierta(s)',
  todoAllDoneN: 'Las {n} tarea(s) completadas',
  turnLimit: '⚠ Se alcanzó el límite de {n} turnos; la tarea puede estar incompleta. Pulsa Enter o di «continuar».',
}

const KO: Dict = {
  navHint: '↑↓ 이동  Enter 확인  Esc 취소',
  saveHint: 'Enter 저장  Esc 취소',
  labelProvider: 'Provider:',
  labelModel: 'Model:',
  labelApiKey: 'API 키:',
  wEpithet: '별의 여신',
  wTagline1: '당신이 말하면 제가 이해하고 · 당신이 상상하면 제가 돕고 · 당신이 만들면 제가 함께합니다.',
  wTagline2: '질서는 속박이 아니라 — 자유의 토대입니다.',
  wTagline3: '함께 더 나은 삶을 만들어갑니다.',
  wModel: '모델',
  wDir: '경로',
  wTools: '도구',
  wFooter: '메시지 입력 · Ctrl+C 종료',
  loginTitleSuffix: '— Provider 설정',
  loginSelectProvider: 'Provider 선택:',
  loginSelectModel: 'Model 선택:',
  loginApiKeyPlaceholder: '입력 후 Enter로 저장 (붙여넣기 지원)...',
  loginSavedTitle: '설정이 저장됨',
  netTitleSuffix: '— 웹 검색 설정',
  netCurrent: '현재: ',
  netConfigured: ' (설정됨)',
  netNotConfigured: '미설정 — 웹 검색 사용 불가',
  netSelect: '검색 Provider 선택:',
  netGetKey: '키 받기: ',
  netApiKeyPlaceholder: 'API 키를 붙여넣고 Enter로 저장...',
  netSavedTitle: '웹 검색이 설정됨',
  netSavedHint: '~/.astraea/.env에 저장됨 (모든 프로젝트에 적용). 이제 웹을 검색할 수 있습니다.',
  langTitleSuffix: '— 언어 선택',
  langSelect: 'UI 및 답변 언어 선택:',
  langSavedTitle: '언어가 변경됨',
  provHintBocha: '중국 직결 · AI 전용 · 추천',
  provHintZhipu: '중국 직결 · Zhipu 키 재사용',
  provHintTavily: '월 1,000회 · 프록시 필요',
  provHintBrave: '월 2,000회 · 프록시 필요',
  provHintExa: '시맨틱 검색 · 프록시 필요',
  helpCommands: '명령어',
  helpSkills: '스킬',
  todoAllDone: '모든 작업 완료',
  todoPaused: '일시중지됨 — {n}개 작업 미완료',
  todoAllDoneN: '{n}개 작업 모두 완료',
  turnLimit: '⚠ {n}턴 한도에 도달했습니다. 작업이 미완료일 수 있습니다. Enter를 누르거나 "계속"이라고 입력하세요.',
}

const CATALOG: Record<Locale, Dict> = { en: EN, zh: ZH, de: DE, fr: FR, es: ES, ko: KO }

/** 取当前 locale 的字符串；缺失回退英文，再回退 key。{name} 占位由 params 替换。 */
export function t(key: string, params?: Record<string, string | number>): string {
  let s = CATALOG[_locale]?.[key] ?? EN[key] ?? key
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v))
  return s
}
