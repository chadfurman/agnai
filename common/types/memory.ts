export type UserEmbed<T = {}> = {
  id: string
  distance: number
  text: string
  date: string
} & T

export type ChatEmbed = {
  id: string
  distance: number
  text: string
  date: string
  name: string
}
