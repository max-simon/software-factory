export type DomainErrorCode =
  | 'invalid_transition'
  | 'not_editable'
  | 'not_active'
  | 'questions_not_allowed'
  | 'approvals_not_allowed'
  | 'unknown_question'
  | 'invalid_answer'
  | 'unknown_item'
  | 'invalid_review'
  | 'foreign_pull_request'
  | 'unknown_pull_request'
  | 'unknown_task'
  | 'invalid_follow_up'
  | 'follow_up_not_allowed'
  | 'unknown_follow_up'
  | 'invalid_clarification'
  | 'invalid_dependencies'
  | 'has_waiting_dependents'
  | 'no_execution';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
