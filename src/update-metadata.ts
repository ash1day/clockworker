#!/usr/bin/env tsx
/**
 * S3の既存データからメタデータを生成・更新
 */

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import * as dotenv from 'dotenv'
import { aggregateMetadata } from './metadata'

dotenv.config({ override: true })

const BUCKET_NAME = 'tftips'
const PREFIX = 'match-data/'

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

async function scanS3AndUpdateMetadata() {
  console.log('📊 Scanning S3 for match data...\n')

  const patchStats = new Map<string, Map<string, number>>()

  // List all files
  const listCommand = new ListObjectsV2Command({
    Bucket: BUCKET_NAME,
    Prefix: PREFIX,
    MaxKeys: 1000
  })

  const response = await s3Client.send(listCommand)
  const files = response.Contents || []

  // Count matches per patch/region
  for (const file of files) {
    if (file.Key?.endsWith('.parquet')) {
      const parts = file.Key.replace(PREFIX, '').split('/')
      if (parts.length >= 3) {
        const region = parts[0]
        const patch = parts[1]

        // パッチ番号の形式をチェック（1515.00形式のみ）
        if (/^\d{4}\.\d{2}$/.test(patch)) {
          if (!patchStats.has(patch)) {
            patchStats.set(patch, new Map())
          }

          // ファイルサイズから概算マッチ数を計算（1マッチ約1.5KB）
          const estimatedMatches = Math.round((file.Size || 0) / 1500)

          patchStats.get(patch)?.set(region, estimatedMatches)
          console.log(`  ${patch}/${region}: ~${estimatedMatches} matches (${Math.round((file.Size || 0) / 1024)}KB)`)
        }
      }
    }
  }

  if (patchStats.size === 0) {
    console.log('No match data found in S3')
    return
  }

  // メタデータを更新
  console.log('\n📝 Updating metadata...')
  await aggregateMetadata(patchStats)

  console.log('✅ Metadata updated successfully!')
}

// 実行
if (require.main === module) {
  scanS3AndUpdateMetadata().catch(console.error)
}
