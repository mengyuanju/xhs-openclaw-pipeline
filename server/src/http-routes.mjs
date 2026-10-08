import { createControlPlaneRouteResources } from './http-route-resources.mjs';
import { installAccountsRoutes } from './http-accounts-routes.mjs';
import { installExecutionsRoutes } from './http-executions-routes.mjs';
import { installTasksRoutes } from './http-tasks-routes.mjs';
import { installConfigurationRoutes } from './http-configuration-routes.mjs';
import { installQueryPackagesRoutes } from './http-query-packages-routes.mjs';
import { installQualityRoutes } from './http-quality-routes.mjs';
import { installReportsRoutes } from './http-reports-routes.mjs';
import { installDeliveryRoutes } from './http-delivery-routes.mjs';
import { installImageEditingRoutes } from './http-image-editing-routes.mjs';
export function installControlPlaneRoutes(options) {
  const resources = createControlPlaneRouteResources(options);
  const context = {
    ...options,
    ...resources
  };
  installAccountsRoutes(context);
  installExecutionsRoutes(context);
  installTasksRoutes(context);
  installConfigurationRoutes(context);
  installQueryPackagesRoutes(context);
  installQualityRoutes(context);
  installReportsRoutes(context);
  installDeliveryRoutes(context);
  installImageEditingRoutes(context);
  return resources.dispose;
}
