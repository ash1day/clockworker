import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const BUCKET_NAME = 'tftips'
const METADATA_KEY = 'match-data/metadata.json'

interface CollectionMetadata {
  lastUpdated: string
  latestPatch: string
  patches: {
    [patch: string]: {
      regions: {
        [region: string]: {
          matchCount: number
          lastUpdated: string
        }
      }
    }
  }
  totalMatches: number
}

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-northeast-1',
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
      : undefined
})

/**
 * メタデータを取得
 */
export async function getMetadata(): Promise<CollectionMetadata | null> {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: METADATA_KEY
    })

    const response = await s3Client.send(command)
    const body = await response.Body?.transformToString()

    if (body) {
      return JSON.parse(body)
    }
  } catch (error: any) {
    if (error.Code === 'NoSuchKey') {
      console.log('No metadata file exists yet')
    } else {
      console.error('Failed to get metadata:', error)
    }
  }

  return null
}

/**
 * メタデータを更新
 */
export async function updateMetadata(patch: string, region: string, matchCount: number): Promise<void> {
  // 既存のメタデータを取得
  let metadata = await getMetadata()

  if (!metadata) {
    metadata = {
      lastUpdated: new Date().toISOString(),
      latestPatch: patch,
      patches: {},
      totalMatches: 0
    }
  }

  // パッチ情報を更新
  if (!metadata.patches[patch]) {
    metadata.patches[patch] = { regions: {} }
  }

  if (!metadata.patches[patch].regions[region]) {
    metadata.patches[patch].regions[region] = {
      matchCount: 0,
      lastUpdated: new Date().toISOString()
    }
  }

  // マッチ数を更新
  metadata.patches[patch].regions[region].matchCount = matchCount
  metadata.patches[patch].regions[region].lastUpdated = new Date().toISOString()

  // 合計マッチ数を再計算
  metadata.totalMatches = 0
  for (const patchData of Object.values(metadata.patches)) {
    for (const regionData of Object.values(patchData.regions)) {
      metadata.totalMatches += regionData.matchCount
    }
  }

  // 最新パッチを判定（最も新しいパッチ番号）
  const allPatches = Object.keys(metadata.patches).sort((a, b) => {
    const aNum = Number.parseFloat(a.replace('.', ''))
    const bNum = Number.parseFloat(b.replace('.', ''))
    return bNum - aNum
  })
  metadata.latestPatch = allPatches[0] || patch

  metadata.lastUpdated = new Date().toISOString()

  // S3に保存
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: METADATA_KEY,
    Body: JSON.stringify(metadata, null, 2),
    ContentType: 'application/json'
  })

  await s3Client.send(command)
  console.log(`✅ Updated metadata: ${patch}/${region} - ${matchCount} matches`)
}

/**
 * すべてのメタデータを集計して更新
 */
export async function aggregateMetadata(patchStats: Map<string, Map<string, number>>): Promise<void> {
  const metadata: CollectionMetadata = {
    lastUpdated: new Date().toISOString(),
    latestPatch: '',
    patches: {},
    totalMatches: 0
  }

  // パッチごとに集計
  for (const [patch, regions] of patchStats) {
    metadata.patches[patch] = { regions: {} }

    for (const [region, count] of regions) {
      metadata.patches[patch].regions[region] = {
        matchCount: count,
        lastUpdated: new Date().toISOString()
      }
      metadata.totalMatches += count
    }
  }

  // 最新パッチを判定
  const allPatches = Array.from(patchStats.keys()).sort((a, b) => {
    const aNum = Number.parseFloat(a.replace('.', ''))
    const bNum = Number.parseFloat(b.replace('.', ''))
    return bNum - aNum
  })
  metadata.latestPatch = allPatches[0] || ''

  // S3に保存
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: METADATA_KEY,
    Body: JSON.stringify(metadata, null, 2),
    ContentType: 'application/json'
  })

  await s3Client.send(command)

  console.log('\n📊 Collection Summary:')
  console.log(`  Latest patch: ${metadata.latestPatch}`)
  console.log(`  Total matches: ${metadata.totalMatches}`)
  console.log(`  Patches: ${Object.keys(metadata.patches).join(', ')}`)
}
