"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTenantGateway = exports.tenantOwner = void 0;
exports.dataPath = dataPath;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/** Each account runs in its own process: legacy stores also cache data in memory. */
function dataPath(...parts) {
    return (0, node_path_1.join)(process.env.TENANT_DATA_ROOT || ((0, node_fs_1.existsSync)("/data") ? "/data" : (0, node_path_1.join)(process.cwd(), "data")), ...parts);
}
const tenantOwner = () => process.env.TENANT_OWNER_ID || "";
exports.tenantOwner = tenantOwner;
const isTenantGateway = () => process.env.ACCOUNT_ISOLATION === "true" && !(0, exports.tenantOwner)();
exports.isTenantGateway = isTenantGateway;
