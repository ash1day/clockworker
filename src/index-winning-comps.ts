import 'dotenv/config'
import { main } from './collect-winning-comps'

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
