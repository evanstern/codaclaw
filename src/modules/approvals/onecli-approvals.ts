// OneCLI approval routing removed in coda v3. Not supported.
export const ONECLI_ACTION = 'onecli_credential';
export function resolveOneCLIApproval(_approvalId: string, _selectedOption: string): boolean {
  return false;
}
export function startOneCLIApprovalHandler(_deliveryAdapter: unknown): void {}
export function stopOneCLIApprovalHandler(): void {}
