import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle('@deepseek-ai/dsh-command-oauth', ['lib/types/index.js'], {
  lib: { entry: ['src/index.ts'] },
})
