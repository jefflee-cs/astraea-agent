// 进程级会话模式单例
// 五种模式（参考 Permission & Safety Technical Spec §1.3 模式 × 权限矩阵）：
//   default — 标准权限提示（文件写 ask / shell ask）
//   orbit   — 只读规划，禁止文件写操作（≈ CC plan）
//   cruise  — 文件写自动通过，shell 仍 ask（≈ CC acceptEdits）
//   forge   — 自动接受所有变更，跳过权限确认（≈ CC bypassPermissions，仅红线仍拦截）
//   counsel — 执行前先向用户确认方向（AI 驱动问卷）+ "是否现在开始执行" 第二道闸

export type SessionMode = 'default' | 'orbit' | 'cruise' | 'forge' | 'counsel'

// 权限取向：allow 直接放行 / ask 弹窗确认 / deny 拒绝
export type PermissionBehavior = 'allow' | 'ask' | 'deny'

let _mode: SessionMode = 'default'
// 进入 orbit 时保存上一个模式，ExitOrbitMode 恢复用
let _preModeRef: SessionMode = 'default'

export function getMode(): SessionMode {
  return _mode
}

export function setMode(mode: SessionMode): void {
  if (mode === 'orbit') {
    _preModeRef = _mode
  }
  _mode = mode
}

export function getPreMode(): SessionMode {
  return _preModeRef
}

export function restorePreMode(): void {
  _mode = _preModeRef
}

// ─── 权限矩阵（红线另行叠加；orbit/counsel 的硬拦截在 query.ts 框架层）──────────

/** 文件写（Write/Edit）在该模式下的默认取向。红线会把 allow 降级为 ask（见 redlines）。 */
export function fileWriteBehavior(mode: SessionMode): PermissionBehavior {
  switch (mode) {
    case 'cruise':
    case 'forge':
      return 'allow'
    case 'orbit':
      return 'deny' // query.ts 已在框架层拦截，这里兜底
    case 'counsel':
    case 'default':
    default:
      return 'ask'
  }
}

/**
 * Shell 命令在规则未命中（ruleAction === null）或命中 'ask' 时的取向。
 * forge 放行一切（红线在调用方另判）；其余模式一律询问。
 */
export function shellAskBehavior(mode: SessionMode): PermissionBehavior {
  return mode === 'forge' ? 'allow' : 'ask'
}

/** 模型是否可自行切入该模式：仅允许降级到 orbit，禁止自我提权到 cruise/forge/counsel。 */
export function isModelEnterable(mode: SessionMode): boolean {
  return mode === 'orbit'
}
