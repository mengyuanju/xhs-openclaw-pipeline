'use client';

import { SharedDeliveryWorkbench } from '../delivery-pool/shared-delivery-workbench';

export function OperatorDeliveryHistory({ refreshKey, initialStatus = '' }: { refreshKey: number; initialStatus?: string }) {
  return <SharedDeliveryWorkbench role="USER" historyOnly refreshKey={refreshKey}
    initialState={initialStatus === 'DELIVERED' ? 'DELIVERED' : initialStatus ? 'PACKED' : 'ALL'} />;
}
