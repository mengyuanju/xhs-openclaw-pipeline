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

export function workflowNavigationHrefs(session) {
  const hrefs = ['/workbench'];
  const review = canReviewCopy(session);
  const qualityCheck = canQualityCheckCopy(session);
  const imageQualityCheck = canQualityCheckImage(session);
  if (review) hrefs.push('/query-packages');
  if (review || qualityCheck) hrefs.push('/copy-flow');
  if (qualityCheck) hrefs.push('/copy-qa');
  if (imageQualityCheck) hrefs.push('/image-qa');
  return hrefs;
}

export function canAccessWorkflowPage(session, pathname) {
  if (pathname === '/query-packages' || pathname.startsWith('/query-packages/')) {
    return canReviewCopy(session);
  }
  if (pathname === '/copy-flow' || pathname.startsWith('/copy-flow/')) {
    return canReviewCopy(session) || canQualityCheckCopy(session);
  }
  if (pathname === '/copy-qa' || pathname.startsWith('/copy-qa/')) {
    return canQualityCheckCopy(session);
  }
  if (pathname === '/image-qa' || pathname.startsWith('/image-qa/')) {
    return canQualityCheckImage(session);
  }
  return true;
}
