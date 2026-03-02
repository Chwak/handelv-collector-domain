
/**
 * Convert AWS region name to short region code
 * Examples:
 *   us-east-1 -> use1
 *   us-west-2 -> usw2
 *   eu-west-1 -> euw1
 *   ap-southeast-1 -> apse1
 */
export function getRegionCode(region: string): string {
  const regionMap: { [key: string]: string } = {
    'us-east-1': 'use1',
    'us-east-2': 'use2',
    'us-west-1': 'usw1',
    'us-west-2': 'usw2',
    'eu-west-1': 'euw1',
    'eu-west-2': 'euw2',
    'eu-west-3': 'euw3',
    'eu-central-1': 'euc1',
    'ap-southeast-1': 'apse1',
    'ap-southeast-2': 'apse2',
    'ap-northeast-1': 'apne1',
    'ap-northeast-2': 'apne2',
    'ap-south-1': 'aps1',
    'ca-central-1': 'cac1',
    'sa-east-1': 'sae1',
  };

  // If already a short code (3-4 chars), return as-is
  if (region.length <= 4 && /^[a-z0-9]+$/.test(region)) {
    return region;
  }

  // If mapping exists, return mapped value
  if (regionMap[region.toLowerCase()]) {
    return regionMap[region.toLowerCase()];
  }

  // Fallback: convert region name to short code
  // us-east-1 -> use1 (first 2 chars of each part, last digit)
  const parts = region.toLowerCase().split('-');
  if (parts.length >= 3) {
    const code = parts[0].substring(0, 2) + parts[1].substring(0, 1) + parts[2];
    return code.substring(0, 4); // Max 4 chars
  }

  // If can't convert, return first 4 chars
  return region.toLowerCase().substring(0, 4).replace(/[^a-z0-9]/g, '');
}
