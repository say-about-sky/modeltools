// EU5 单位动画状态机的最小 JS 复刻（g3d-web 调试用）。
//
// 只保留我们当前 combo 能播放的状态：
//   Idle / Move / Retreat 循环；Attack 用 battle 动画循环。
// EU5 的 idle_to_attack / attack_to_idle 过渡动画在我们的 combo 里不存在，
// 因此这里直接交叉切换；进入 Idle 时可选随机相位。

export const UNIT_STATE_NAMES = {
  0: 'Idle',
  1: 'Attack',
  2: 'Move',
  3: 'Retreat',
  4: 'Charge',
};

/** 状态机状态 → g3d-web 的四态显示 id。 */
export const DISPLAY_STATE = {
  Idle: 'idle',
  Attack: 'battle',
  Move: 'move',
  Retreat: 'retreat',
  Charge: 'battle',
};

export class UnitStateMachine {
  constructor(options = {}) {
    this.getDuration = options.getDuration || (() => 0);
    this.onStateChange = options.onStateChange || (() => {});
    this.randomPhase = !!options.randomPhase;
    this.reset(options.state || 'Idle', options.unitState == null ? 1 : options.unitState);
  }

  reset(state = 'Idle', unitState = 1) {
    this.state = state;
    this.unitState = unitState;
    this.time = 0;
    this.transition = null;
    this.lastEvent = null;
    const dur = this.duration();
    if (this.randomPhase && dur > 0 && state !== 'Attack') {
      this.time = Math.random() * dur;
    }
  }

  duration(state = this.state) {
    const id = DISPLAY_STATE[state];
    return id ? Math.max(0, this.getDuration(id) || 0) : 0;
  }

  /** 切换状态；返回是否发生切换。 */
  change(to) {
    if (to === this.state) return false;
    const from = this.state;
    this.state = to;
    this.time = 0;
    this.transition = { from, to, startedAt: performance.now() };
    const dur = this.duration();
    if (this.randomPhase && dur > 0 && (to === 'Idle' || to === 'Move' || to === 'Retreat')) {
      this.time = Math.random() * dur;
    }
    this.onStateChange(to, from, { duration: dur, time: this.time });
    return true;
  }

  update(dt, unitState) {
    if (unitState != null) this.unitState = unitState;
    const dur = this.duration();
    this.time += dt;

    // 1) 状态转场判定（顺序参考 unit_skeleton_state_machine_musket.animsm）
    if (this.state === 'Idle') {
      if (this.unitState === 2) this.change('Move');
      else if (this.unitState === 3) this.change('Retreat');
      else if (this.unitState === 4) this.change('Charge');
      else if (this.unitState === 1 && dur > 0 && this.time >= dur) this.change('Attack');
    } else if (this.state === 'Attack') {
      if (this.unitState === 2) this.change('Move');
      else if (this.unitState === 3) this.change('Retreat');
      else if (this.unitState === 4) this.change('Charge');
      else if (this.unitState !== 1) this.change('Idle');
    } else if (this.state === 'Move') {
      if (this.unitState !== 2) this.change('Idle');
    } else if (this.state === 'Retreat') {
      if (this.unitState !== 3) this.change('Idle');
    } else if (this.state === 'Charge') {
      if (this.unitState !== 4) this.change('Idle');
    }

    // 2) 循环回绕（转场已在上一步处理）
    const dur2 = this.duration();
    if (dur2 > 0 && this.time >= dur2) {
      this.time %= dur2;
    }
    if (this.transition && performance.now() - this.transition.startedAt > 1200) {
      this.transition = null;
    }
  }

  snapshot() {
    const dur = this.duration();
    return {
      state: this.state,
      displayState: DISPLAY_STATE[this.state] || 'idle',
      unitState: this.unitState,
      unitStateName: UNIT_STATE_NAMES[this.unitState] || String(this.unitState),
      time: this.time,
      duration: dur,
      progress: dur > 0 ? this.time / dur : 0,
      transition: this.transition,
    };
  }
}
