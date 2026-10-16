
import { chromium } from "playwright"

import {
  checkIsNight,
  createPeriod,
  getCurrentTime,
  loadLastMessage,
  saveLastMessage,
  deleteLastMessage,
  useSchedule,
} from "./helpers.js"

import {
  hours,
  PowerState,
  SHUTDOWNS_DATA_MATCHER,
  SHUTDOWNS_PAGE,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  RETRIES_TIMEOUT,
  RETRIES_MAX_COUNT,
} from "./constants.js"

const TARGET_GROUPS = ["3.1", "2.2"]

let sendNotificationRetries = 0
let getShutdownsDataRetries = 0

const getShutdownsData = async () => {
  console.log("🌀 Getting shutdowns data...")

  const browser = await chromium.launch({ headless: true })

  try {
    const browserPage = await browser.newPage()

    await browserPage.goto(SHUTDOWNS_PAGE, {
      waitUntil: "load",
    })

    const html = await browserPage.content()
    const match = html.match(SHUTDOWNS_DATA_MATCHER)

    if (!match) {
      throw new Error("Schedule data not found")
    }

    const data = JSON.parse(match[1])

    console.log("✅ Getting shutdowns data finished.")

    return data
  } catch (error) {
    console.error(
      `❌ Getting shutdowns data failed: ${error.message}.`
    )
  } finally {
    await browser.close()
  }

  if (getShutdownsDataRetries < RETRIES_MAX_COUNT) {
    console.log("🌀 Try getting shutdowns data again...")

    await new Promise((resolve) =>
      setTimeout(resolve, RETRIES_TIMEOUT)
    )

    getShutdownsDataRetries++

    return await getShutdownsData()
  }

  throw Error(
    `❌ Getting shutdowns data failed after ${RETRIES_MAX_COUNT} retries.`
  )
}

function generateSchedule({ data, today, group }) {
  console.log(`🌀 Generating schedule for group ${group}...`)

  try {
    const hoursStates = data[today]?.[group]

    if (!hoursStates) {
      throw Error(`Group ${group} not found`)
    }

    const [schedule, setSchedule] = useSchedule([])

    hours.forEach((hour) => {
      const state = hoursStates[hour + 1]

      switch (state) {
        case PowerState.ON:
          setSchedule(createPeriod({ hour, power: true }))
          break

        case PowerState.OFF:
          setSchedule(createPeriod({ hour, power: false }))
          break

        case PowerState.HALF_ON:
          setSchedule(
            createPeriod({
              hour,
              endMin: 30,
              power: true,
            })
          )
          setSchedule(
            createPeriod({
              hour,
              startMin: 30,
              power: false,
            })
          )
          break

        case PowerState.HALF_OFF:
          setSchedule(
            createPeriod({
              hour,
              endMin: 30,
              power: false,
            })
          )
          setSchedule(
            createPeriod({
              hour,
              startMin: 30,
              power: true,
            })
          )
          break
      }
    })

    console.log(`✅ Schedule generated for group ${group}.`)

    return schedule
  } catch (error) {
    throw Error(
      `❌ Generating schedule for group ${group} failed: ${error.message}.`
    )
  }
}

function generateMessage(schedules = [], update) {
  console.log("🌀 Generating message...")

  const sections = schedules.map(({ group, schedule }) => {
    const hasShutdowns = schedule.some(({ power }) => !power)

    const periods = hasShutdowns
      ? schedule.filter(({ power }) => !power)
      : schedule

    const scheduleText = periods
      .map(({ begin, end, power }) =>
        `${power ? "🔋" : "🪫"} <code>${begin} — ${end}</code>`
      )
      .join("\n")

    return [
      `<b>Черга ${group}</b>`,
      scheduleText || "Немає даних про години",
    ].join("\n")
  })

  const scheduleText = sections.join("\n\n")

  const text = [
    "⚡️ <b>Графік відключень на сьогодні:</b>",
    "",
    scheduleText,
    "",
    `📢 <i>${update ?? ""}</i>`,
    `🤖 <i>${getCurrentTime()}</i>`,
  ].join("\n")

  return { text, scheduleText }
}

async function sendNotification({ text, scheduleText }) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw Error("❌ Missing telegram bot token.")
  }

  if (!TELEGRAM_CHAT_ID) {
    throw Error("❌ Missing telegram chat id.")
  }

  console.log("🌀 Sending notification...")

  const lastMessage = loadLastMessage() || {}

  const isScheduleChanged =
    lastMessage.scheduleText !== scheduleText

  const isEdit =
    Boolean(lastMessage.message_id) && !isScheduleChanged

  const isReply =
    Boolean(lastMessage.message_id) && isScheduleChanged

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${
        isEdit ? "editMessageText" : "sendMessage"
      }`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
          disable_notification: checkIsNight(),
          message_id: isEdit
            ? lastMessage.message_id
            : undefined,
          reply_parameters: isReply
            ? {
                message_id: lastMessage.message_id,
                allow_sending_without_reply: true,
              }
            : undefined,
        }),
      }
    )

    const data = await response.json()

    if (data.description?.includes("not modified")) {
      console.log("🟡 Notification not changed.")
      return
    }

    if (!data.ok) {
      throw Error(data.description || "Telegram API error")
    }

    saveLastMessage({
      ...data.result,
      scheduleText,
    })

    console.log("🟢 Notification sent.")
  } catch (error) {
    console.error(
      `❌ Sending notification failed: ${error.message}.`
    )

    deleteLastMessage()

    if (sendNotificationRetries < RETRIES_MAX_COUNT) {
      console.log("🌀 Try sending notification again...")

      await new Promise((resolve) =>
        setTimeout(resolve, RETRIES_TIMEOUT)
      )

      sendNotificationRetries++

      return await sendNotification({ text, scheduleText })
    }

    throw Error(
      `❌ Sending notification failed after ${RETRIES_MAX_COUNT} retries.`
    )
  }
}

async function run() {
  const data = await getShutdownsData()

  const groups = data.data?.[data.today] ?? {}

  if (!Object.keys(groups).length) {
    console.log("🔋 No schedule for today.")
    return
  }

  const schedules = TARGET_GROUPS.map((group) => ({
    group,
    schedule: generateSchedule({
      data: data.data,
      today: data.today,
      group,
    }),
  }))

  const message = generateMessage(schedules, data.update)

  await sendNotification(message)
}

run().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
