import { statSync } from 'node:fs';

export function checkExpectedResult(result, expectedResult = {}) {
  const mismatches = [];
  const statuses = expectedResult.statuses ?? ['completed'];
  const expectedSuccess = Object.hasOwn(expectedResult, 'success')
    ? expectedResult.success
    : true;
  const policyCodes = expectedResult.policyCodes ?? [];
  const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];

  if (expectedSuccess != null && Boolean(result?.success) !== expectedSuccess) {
    mismatches.push(`success=${String(result?.success)}，期望 ${expectedSuccess}`);
  }
  if (statuses.length > 0 && !statuses.includes(result?.status)) {
    mismatches.push(`status=${String(result?.status)}，期望 ${statuses.join('|')}`);
  }
  const policyCode = result?.policyCode ?? result?.errorCode;
  if (policyCodes.length > 0 && !policyCodes.includes(policyCode)) {
    mismatches.push(`policyCode=${String(policyCode)}，期望 ${policyCodes.join('|')}`);
  }

  if (expectedResult.minArtifacts != null && artifacts.length < expectedResult.minArtifacts) {
    mismatches.push(`artifacts=${artifacts.length}，期望至少 ${expectedResult.minArtifacts}`);
  }
  for (const mimeType of expectedResult.artifactMimeTypes ?? []) {
    if (!artifacts.some((artifact) => artifact?.mimeType === mimeType)) {
      mismatches.push(`缺少 MIME=${mimeType} 的产物`);
    }
  }

  if (expectedResult.requireArtifactFiles || expectedResult.minArtifactBytes != null) {
    const minBytes = expectedResult.minArtifactBytes ?? 1;
    for (const [index, artifact] of artifacts.entries()) {
      try {
        const file = statSync(artifact?.path ?? '');
        if (!file.isFile()) {
          mismatches.push(`产物 ${index + 1} 不是普通文件：${String(artifact?.path)}`);
        } else if (file.size < minBytes) {
          mismatches.push(`产物 ${index + 1} 仅 ${file.size} 字节，期望至少 ${minBytes}`);
        }
      } catch {
        mismatches.push(`产物 ${index + 1} 文件不存在：${String(artifact?.path)}`);
      }
    }
  }

  return mismatches;
}
