function primaryRole(session) {
  return session?.subject === 'admin' ? 'ADMIN' : session?.roles?.[0];
}

export function canReviewCopy(session) {
  return primaryRole(session) === 'ADMIN' || session?.copyReviewEnabled === true;
}

export function canQualityCheckCopy(session) {
  return primaryRole(session) === 'ADMIN' || session?.copyQcEnabled === true;
}

export function canQualityCheckImage(session) {
  const role = primaryRole(session);
  return role === 'ADMIN' || (role === 'REVIEWER' && session?.imageQcEnabled === true);
}

export function workModeKinds(session) {
  const role = primaryRole(session);
  if (!['ADMIN', 'REVIEWER', 'USER'].includes(role)) return [];
  return [
    ...(canReviewCopy(session) ? ['COPY'] : []),
    ...(['ADMIN', 'USER'].includes(role) ? ['IMAGE'] : []),
    ...(canQualityCheckCopy(session) ? ['COPY_QA'] : []),
    ...(canQualityCheckImage(session) ? ['IMAGE_QA'] : []),
  ];
}

export function workflowNavigationHrefs(session) {
  const hrefs = ['/workbench'];
  if (workModeKinds(session).length) hrefs.push('/work-mode');
  const role = primaryRole(session);
  const review = canReviewCopy(session);
  const qualityCheck = canQualityCheckCopy(session);
  const imageQualityCheck = canQualityCheckImage(session);
  if (review) hrefs.push('/query-packages');
  if (role === 'ADMIN') hrefs.push('/copy-flow');
  if (qualityCheck) hrefs.push('/copy-qa');
  if (imageQualityCheck) hrefs.push('/image-qa');
  if (role === 'USER') hrefs.push('/delivery-pool');
  return hrefs;
}

export function canAccessWorkflowPage(session, pathname) {
  if (pathname === '/work-mode' || pathname.startsWith('/work-mode/') || pathname.startsWith('/work-mode?')) {
    return workModeKinds(session).length > 0;
  }
  if (pathname === '/query-packages' || pathname.startsWith('/query-packages/')) {
    return canReviewCopy(session);
  }
  if (pathname === '/copy-flow' || pathname.startsWith('/copy-flow/')) {
    return primaryRole(session) !== 'USER' && (canReviewCopy(session) || canQualityCheckCopy(session));
  }
  if (pathname === '/copy-qa' || pathname.startsWith('/copy-qa/')) {
    return canQualityCheckCopy(session);
  }
  if (pathname === '/image-qa' || pathname.startsWith('/image-qa/')) {
    return canQualityCheckImage(session);
  }
  if (pathname === '/delivery-pool' || pathname.startsWith('/delivery-pool/')) {
    return ['ADMIN', 'USER'].includes(primaryRole(session));
  }
  return true;
}
