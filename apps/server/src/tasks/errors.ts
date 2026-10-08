/**
 * Task-domain error taxonomy: one class per catalog code so the MCP
 * layer maps them by catalog code in taskToolError.
 */
export class TaskAgentNotFoundError extends Error {
  readonly code = "agent_not_found";
  constructor(agentId: string) {
    super(`agent not found: ${agentId}`);
    this.name = "TaskAgentNotFoundError";
  }
}

export class TaskInvalidStatusError extends Error {
  readonly code = "invalid_status";
  constructor(status: string) {
    super(`invalid task status: ${status}`);
    this.name = "TaskInvalidStatusError";
  }
}

export class TaskNotFoundError extends Error {
  readonly code = "task_not_found";
  constructor(taskId: string) {
    super(`task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class TaskAlreadyClaimedError extends Error {
  readonly code = "task_already_claimed";
  constructor(taskId: string) {
    super(`task already claimed: ${taskId}`);
    this.name = "TaskAlreadyClaimedError";
  }
}

export class TaskVersionMismatchError extends Error {
  readonly code = "version_mismatch";
  constructor(taskId: string) {
    super(`version mismatch: ${taskId}`);
    this.name = "TaskVersionMismatchError";
  }
}

export class TaskUnauthorizedError extends Error {
  readonly code = "unauthorized";
  constructor(taskId: string) {
    super(`not coordinator with a live lease: ${taskId}`);
    this.name = "TaskUnauthorizedError";
  }
}

export class TaskAlreadyAssignedError extends Error {
  readonly code = "already_assigned";
  constructor(taskId: string, agentId: string) {
    super(`already assigned: ${agentId} on ${taskId}`);
    this.name = "TaskAlreadyAssignedError";
  }
}

export class TaskNotAssignedError extends Error {
  readonly code = "not_assigned";
  constructor(taskId: string, agentId: string) {
    super(`not assigned: ${agentId} on ${taskId}`);
    this.name = "TaskNotAssignedError";
  }
}
