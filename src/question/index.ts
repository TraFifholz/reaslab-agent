// Stub: question module not available in reaslab-agent
import z from "zod"

export namespace Question {
  export class RejectedError extends Error {
    constructor() {
      super("Question rejected")
      this.name = "QuestionRejectedError"
    }
  }

  /** An Answer is an array of selected option labels */
  export type Answer = string[]

  export const Info = z.object({
    question: z.string(),
    custom: z.boolean().optional(),
  })
  export type Info = z.infer<typeof Info>

  export async function ask(_input: {
    questions?: any[]
    sessionID?: string
    messageID?: string
    callID?: string
    tool?: { messageID: string; callID: string }
  }): Promise<Answer[]> {
    return []
  }
}
