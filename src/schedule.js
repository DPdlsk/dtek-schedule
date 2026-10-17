
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

import {
  checkIsNight,
  createPeriod,
  getCurrentTime,
  loadLastMessage,
  saveLastMessage,
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

const TARGET_GROUPS = ["GPV3.1", "GPV2.2"]

const TOMORROW_STATE_FILE = path.resolve(
  "artifacts",
  "last-tomorrow-schedule.json"
)

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
      throw new Error("Shutdowns data not found in page HTML")
    }

    const result = JSON.parse(match[1])

    console.log("✅ Getting shutdowns data finished.")

    return result
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

    console.log(
      `✅ Generating schedule for group ${group} finished.`
    )

    return schedule
  } catch (error) {
    throw Error(
      `❌ Generating schedule for group ${group} failed: ${error.message}.`
    )
  }
}

function generateMessage(schedules, update) {
  console.log("🌀 Generating message...")

  const sections = schedules.map(({ group, schedule }) => {
    const displayGroup = group.replace("GPV", "")
    const hasShutdowns = schedule.some(({ power }) => !power)

    const scheduleLines = hasShutdowns
      ? schedule
          .filter(({ power }) => !power)
          .map(({ begin, end }) => `🪫 <code>${begin} — ${end}</code>`)
      : schedule.map(
          ({ begin, end }) => `🔋 <code>${begin} — ${end}</code>`
        )

    return {
      group: displayGroup,
      scheduleText: scheduleLines.join("\n"),
      text: [
        `📍 <b>Черга ${displayGroup}</b>`,
        ...scheduleLines,
      ].join("\n"),
    }
  })

  const scheduleText = sections
    .map(
      ({ group, scheduleText }) =>
        `Черга ${group}\n${scheduleText}`
    )
    .join("\n\n")

  const text = [
    "⚡️ <b>Графік відключень на сьогодні:</b>",
    "",
    ...sections.map(({ text }) => text),
    "",
    `📢 <i>${update ?? "Оновлення сайту ДТЕК"}</i>`,
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

  const isScheduleChanged = lastMessage.scheduleText !== scheduleText
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

    const result = await response.json()

    if (result.description?.includes("not modified")) {
      console.log("🟡 Notification not changed.")
      return
    }

    if (!result.ok) {
      throw Error(result.description)
    }

    saveLastMessage({
      ...result.result,
      scheduleText,
    })

    console.log("🟢 Notification sent.")
  } catch (error) {
    console.error(
      `❌ Sending notification failed: ${error.message}.`
    )

    // Зберігаємо message_id при тимчасових мережевих помилках.

    if (sendNotificationRetries < RETRIES_MAX_COUNT) {
      await new Promise((resolve) =>
        setTimeout(resolve, RETRIES_TIMEOUT)
      )

      sendNotificationRetries++

      console.log("🌀 Try sending notification again...")

      return await sendNotification({ text, scheduleText })
    }

    throw Error(
      `❌ Sending notification failed after ${RETRIES_MAX_COUNT} retries.`
    )
  }
}

// Окремий стан завтрашнього графіка.
function loadTomorrowState() {
  try {
    if (!fs.existsSync(TOMORROW_STATE_FILE)) {
      return null
    }

    return JSON.parse(
      fs.readFileSync(TOMORROW_STATE_FILE, "utf8")
    )
  } catch (error) {
    console.error(
      `⚠️ Cannot load tomorrow state: ${error.message}`
    )
    return null
  }
}

function saveTomorrowState(state) {
  fs.mkdirSync(path.dirname(TOMORROW_STATE_FILE), {
    recursive: true,
  })

  fs.writeFileSync(
    TOMORROW_STATE_FILE,
    JSON.stringify(state, null, 2)
  )
}

function formatDate(timestamp) {
  return new Date(Number(timestamp) * 1000).toLocaleDateString(
    "uk-UA",
    {
      timeZone: "Europe/Kyiv",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }
  )
}

function hasValidSchedule(data, date, group) {
  const states = data?.[date]?.[group]

  if (!states || typeof states !== "object") {
    return false
  }

  const validStates = Object.values(PowerState)

  // Відкидаємо відсутні та невідомі стани.
  return Object.values(states).some(
    (state) => validStates.includes(state)
  )
}

async function publishTomorrowSchedule(result) {
  console.log("🌀 Checking tomorrow's schedule...")

  const dates = Object.keys(result.data ?? {})
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)

  const todayTimestamp = Number(result.today)

  // ДТЕК передає дати як Unix timestamps.
  const tomorrowTimestamp = dates.find(
    (timestamp) => timestamp > todayTimestamp
  )

  if (!tomorrowTimestamp) {
    console.log("ℹ️ No schedule date for tomorrow yet.")
    return
  }

  const tomorrow = String(tomorrowTimestamp)

  // Кожна черга перевіряється незалежно.
  const availableGroups = TARGET_GROUPS.filter((group) =>
    hasValidSchedule(result.data, tomorrow, group)
  )

  if (availableGroups.length === 0) {
    console.log(
      "ℹ️ No valid schedules for target groups tomorrow."
    )
    return
  }

  const schedules = availableGroups.map((group) => ({
    group,
    schedule: generateSchedule({
      data: result.data,
      today: tomorrow,
      group,
    }),
  }))

  // Порівнюємо години та стани, ігноруючи час оновлення ДТЕК.
  const scheduleText = JSON.stringify(
    schedules.map(({ group, schedule }) => ({
      group,
      schedule: schedule.map(({ begin, end, power }) => ({
        begin,
        end,
        power,
      })),
    }))
  )

  const previous = loadTomorrowState()

  if (
    previous?.date === tomorrow &&
    previous?.scheduleText === scheduleText
  ) {
    console.log("🟡 Tomorrow's schedule has not changed.")
    return
  }

  const sections = schedules.map(({ group, schedule }) => {
    const displayGroup = group.replace("GPV", "")
    const hasShutdowns = schedule.some(({ power }) => !power)

    const lines = hasShutdowns
      ? schedule
          .filter(({ power }) => !power)
          .map(({ begin, end }) => `🪫 <code>${begin} — ${end}</code>`)
      : schedule.map(
          ({ begin, end }) => `🔋 <code>${begin} — ${end}</code>`
        )

    return [
      `📍 <b>Черга ${displayGroup}</b>`,
      ...lines,
    ].join("\n")
  })

  const text = [
    `📅 <b>Графік відключень на завтра — ${formatDate(tomorrowTimestamp)}</b>`,
    "",
    ...sections,
    "",
    `📢 <i>${result.update ?? "Дані ДТЕК"}</i>`,
    `🤖 <i>${getCurrentTime()}</i>`,
  ].join("\n")

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw Error("Missing Telegram bot token or chat ID.")
  }

  console.log("🌀 Publishing tomorrow's schedule...")

  // Окремі повторні спроби для завтрашнього повідомлення.
  let lastError

  for (let attempt = 0; attempt <= RETRIES_MAX_COUNT; attempt++) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
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
          }),
        }
      )

      const telegramResult = await response.json()

      if (!response.ok || !telegramResult.ok) {
        throw Error(
          telegramResult.description ?? `HTTP ${response.status}`
        )
      }

      // Зберігаємо стан тільки після успішної публікації.
      saveTomorrowState({
        date: tomorrow,
        scheduleText,
        message_id: telegramResult.result.message_id,
        chat_id: telegramResult.result.chat.id,
      })

      console.log("🟢 Tomorrow's schedule published.")
      return
    } catch (error) {
      lastError = error

      console.error(
        `❌ Tomorrow notification failed: ${error.message}.`
      )

      if (attempt < RETRIES_MAX_COUNT) {
        console.log("🌀 Retrying tomorrow notification...")

        await new Promise((resolve) =>
          setTimeout(resolve, RETRIES_TIMEOUT)
        )
      }
    }
  }

  // Не зберігаємо новий стан, якщо публікація не підтверджена.
  throw Error(
    `Tomorrow notification failed after retries: ${lastError?.message}`
  )
}

async function run() {
  const result = await getShutdownsData()

  console.log("Today:", result.today)
  console.log("Available dates:", Object.keys(result.data ?? {}))

  // Завтрашній сценарій незалежний від сьогоднішнього.
  try {
    await publishTomorrowSchedule(result)
  } catch (error) {
    console.error(
      `❌ Tomorrow schedule processing failed: ${error.message}`
    )
  }

  const todayData = result.data?.[result.today] ?? {}

  console.log("Available groups:", Object.keys(todayData))

  if (!Object.keys(todayData).length) {
    console.log("🔋 No schedule data found for today.")

    await sendNotification({
      text: [
        "⚠️ <b>Графік відключень на сьогодні ще не опублікований.</b>",
        "",
        `📢 <i>${result.update ?? "Дані ДТЕК"}</i>`,
        `🤖 <i>Перевірено: ${getCurrentTime()}</i>`,
      ].join("\n"),
      scheduleText: "NO_SCHEDULE",
    })

    return
  }

  const schedules = TARGET_GROUPS
    .filter((group) =>
      hasValidSchedule(result.data, result.today, group)
    )
    .map((group) => ({
      group,
      schedule: generateSchedule({
        data: result.data,
        today: result.today,
        group,
      }),
    }))

  if (schedules.length === 0) {
    console.log("⚠️ No valid schedules for today's target groups.")
    return
  }

  const message = generateMessage(schedules, result.update)

  await sendNotification(message)
}

run().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
