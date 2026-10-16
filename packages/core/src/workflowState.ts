export type WorkflowStateValue = 'stateA' | 'stateB';

/** 只有一个全局状态，两个取值；在 Loop 之间保持，重新运行时回到 stateA。 */
export class WorkflowStateMachine {
  private value: WorkflowStateValue;

  constructor(initialValue: WorkflowStateValue = 'stateA') {
    this.value = initialValue;
  }

  get(): WorkflowStateValue {
    return this.value;
  }

  set(value: WorkflowStateValue): WorkflowStateValue {
    this.value = value;
    return value;
  }

  toggle(): WorkflowStateValue {
    this.value = this.value === 'stateA' ? 'stateB' : 'stateA';
    return this.value;
  }

  route(): 'true' | 'false' {
    return this.value === 'stateA' ? 'true' : 'false';
  }

  reset(): void {
    this.value = 'stateA';
  }
}
