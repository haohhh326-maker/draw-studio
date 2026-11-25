// Chrome serializes this function into an isolated world in the AutoDL tab.
// Return only instance summaries, never site tokens, account data or SSH metadata.
export async function runAutoDLCommand(operation, instanceUuid, expiresAt) {
  const failure = (errorCode, response, businessCode, requestId) => {
    const code = typeof businessCode === "string" && /^[A-Za-z0-9_.-]{1,48}$/.test(businessCode) &&
      !/[A-Za-z0-9]{24,}/.test(businessCode) ? businessCode : undefined;
    const validRequestId = typeof requestId === "string" && /^[0-9a-f]{32}$/i.test(requestId);
    return { ok: false, errorCode, ...(response ? { httpStatus: response.status } : {}), ...(code ? { remoteCode: code } : {}),
      ...(validRequestId ? { requestId } : {}) };
  };
  if (location.origin !== "https://www.autodl.art" || location.pathname.replace(/\/$/, "") !== "/app/deploy") {
    return failure("NO_AUTODL_TAB");
  }
  const validId = /^pro-[a-zA-Z0-9-]{1,150}$/;
  if (!["list", "status", "preflight", "power-on", "power-off"].includes(operation) ||
    (operation !== "list" && (typeof instanceUuid !== "string" || !validId.test(instanceUuid)))) {
    return failure("CONTRACT_ERROR");
  }
  try {
    const token = localStorage.getItem("token");
    if (!token) return failure("LOGIN_REQUIRED");
    let subUser = false;
    try { subUser = Boolean(JSON.parse(localStorage.getItem("user") || "null")?.sub_name); }
    catch { /* The site defaults to the main account routes. */ }
    const accountPrefix = "/api/v1/adl_server" + (subUser ? "/sub_user" : "");
    const prefix = accountPrefix + "/instance/pro";
    const api = async (path, body) => {
      const headers = { Authorization: token, Accept: "application/json" };
      if (body) headers["Content-Type"] = "application/json";
      const response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 401) throw failure("LOGIN_REQUIRED", response);
      // A gateway failure may arrive after the platform has accepted a power request.
      if (response.status >= 500 || response.status === 408) throw failure(body ? "POWER_UNKNOWN" : "NETWORK_ERROR", response);
      const result = await response.json().catch(() => null);
      const code = result?.code;
      const rejected = errorCode => failure(errorCode, response, code, result?.request_id);
      if (code === "AuthorizeFailed") throw rejected("LOGIN_REQUIRED");
      if (code === "TORealName") throw rejected("ACCOUNT_PREREQUISITE");
      if (!response.ok || code !== "Success") {
        if (!body) throw rejected("CONTRACT_ERROR");
        // Match known business refusals without exposing the response message.
        if (operation === "power-on" && (code === "InternalError" || code === "BadRequest") && typeof result?.msg === "string") {
          const message = result.msg.trimStart();
          if (/^当前算力规格暂无库存(?:[\s,，。!！:：]|$)/.test(message)) throw rejected("NO_GPU_CAPACITY");
          if (/^(?:[主子]?账[号户]|可用)?余额不足(?:[\s,，。!！:：]|$)/.test(message)) throw rejected("INSUFFICIENT_BALANCE");
          if (/^实例已(?:经)?到期(?:[\s,，。!！:：]|$)/.test(message)) throw rejected("INSTANCE_EXPIRED");
        }
        if (response.status === 409 || ["AlreadyRunning", "InstanceStarting", "InstanceRunning", "InstanceNotShutdown"].includes(code))
          throw rejected("POWER_STATE_CONFLICT");
        if ([400, 403, 404, 412, 422].includes(response.status)) throw rejected("POWER_REJECTED");
        throw rejected("POWER_UNKNOWN");
      }
      return result.data;
    };
    if (operation === "power-on" || operation === "power-off") {
      const poweringOn = operation === "power-on";
      if (!Number.isSafeInteger(expiresAt) || expiresAt - Date.now() < 9000) return failure("COMMAND_EXPIRED");
      await api(prefix + (poweringOn ? "/power_on" : "/power_off"), {
        instance_uuid: instanceUuid,
        ...(poweringOn ? { payload: "" } : {}),
      });
      return { ok: true, value: { accepted: true } };
    }
    const preflight = async (row, status) => {
      const result = { ok: true, value: { status } };
      if (!["shutdown", "shutdown_by_starting_error", "shutdown_by_running_error"].includes(status)) return result;
      if (row.charge_type !== "payg") {
        const expiry = Date.parse(row.expired_at?.Time);
        if (!Number.isFinite(expiry)) return failure("CONTRACT_ERROR");
        return expiry < Date.now() ? failure("INSTANCE_EXPIRED") : result;
      }
      if (typeof row.snapshot_gpu_alias_name !== "string" || !row.snapshot_gpu_alias_name.trim()) return failure("CONTRACT_ERROR");
      const walletQuery = new URLSearchParams({ charge_type: "payg", product_type: "instance_pro", gpu_name: row.snapshot_gpu_alias_name });
      const instanceQuery = new URLSearchParams({ instance_uuid: instanceUuid });
      const [wallet, snapshot] = await Promise.all([
        api(accountPrefix + "/wallet/balance?" + walletQuery),
        api(prefix + "/snapshot?" + instanceQuery),
      ]);
      // The console compares these values directly in milli-yuan.
      const balance = wallet?.assets;
      const voucher = wallet?.voucher_balance;
      const fundingBalance = subUser ? wallet?.primary_account_assets : balance;
      const price = snapshot?.payg_price;
      if (![balance, voucher, fundingBalance, price].every(Number.isSafeInteger) || voucher < 0 || price < 0)
        return failure("CONTRACT_ERROR");
      if ((subUser && balance < price) || (fundingBalance + voucher < price && voucher < price))
        return failure("INSUFFICIENT_BALANCE");
      return result;
    };
    const clean = (value, max) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max) : "";
    const instances = new Map();
    const deadline = Date.now() + 18_000;
    const pageSize = 10;
    for (let page = 1; page <= 50 && Date.now() < deadline; page++) {
      const data = await api(prefix + "?page_index=" + page + "&page_size=" + pageSize);
      if (!Array.isArray(data?.list) || !Number.isSafeInteger(data.result_total) || data.result_total < 0) {
        return failure("CONTRACT_ERROR");
      }
      for (const row of data.list) {
        if (typeof row?.uuid !== "string" || !validId.test(row.uuid)) continue;
        const status = clean(row.status, 64);
        if (!status || !/^[a-z0-9_]+$/.test(status)) {
          if (row.uuid === instanceUuid) return failure("CONTRACT_ERROR");
          continue;
        }
        if (operation === "status" && row.uuid === instanceUuid) return { ok: true, value: { status } };
        if (operation === "preflight" && row.uuid === instanceUuid) return await preflight(row, status);
        const name = clean(row.instance_name, 120) || clean(row.name, 120) || row.uuid;
        instances.set(row.uuid, { instanceUuid: row.uuid, name, status });
      }
      if (page * pageSize >= data.result_total) {
        if (operation !== "list") return failure("INSTANCE_NOT_FOUND");
        return { ok: true, value: { instances: [...instances.values()] } };
      }
      if (!data.list.length) return failure("CONTRACT_ERROR");
    }
    return failure("CONTRACT_ERROR");
  } catch (error) {
    if (error?.ok === false) return error;
    return failure("NETWORK_ERROR");
  }
}
