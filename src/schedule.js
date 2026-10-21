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

const TARGET_GROUPS = [
  ...new Set(
    (process.env.GROUPS || "3.1,2.2")
      .split(",")
      .map((group) => group.trim())
      .filter(Boolean)
      .map((group) =>
        group.toUpperCase().startsWith("GPV")
          ? group.toUpperCase()
          : `GPV${group}`
      )
  ),
]

const TOMORROW_STATE_FILE = path.resolve(
  "artifacts",
  "last-tomorrow-schedule.json"
)

const SWITCHING_STATE_FILE = path.resolve(
  "artifacts",
  "switching-alert-state.json"
)

const SWITCHING_WARNING_MINUTES = 30
const SWITCHING_CORRECTION_WINDOW_MINUTES = 60

let sendNotificationRetries = 0
let getShutdownsDataRetries = 0

function loadTomorrowMessage() {
  if (!fs.existsSync(TOMORROW_STATE_FILE)) {
    return null
  }

  try {
    return JSON.parse(
      fs.readFileSync(TOMORROW_STATE_FILE, "utf8")
    )
  } catch (error) {
    console.error(
      `❌ Failed to read tomorrow state: ${error.message}`
    )
    return null
  }
}

function saveTomorrowMessage(message) {
  fs.mkdirSync(path.dirname(TOMORROW_STATE_FILE), {
    recursive: true,
  })

  fs.writeFileSync(
    TOMORROW_STATE_FILE,
    JSON.stringify(message, null, 2)
  )
}

function loadSwitchingState() {
  try {
    const state = JSON.parse(
      fs.readFileSync(SWITCHING_STATE_FILE, "utf8")
    )

    return {
      nextSwitches: state.nextSwitches ?? {},
      sentWarnings: Array.isArray(state.sentWarnings)
        ? state.sentWarnings
        : [],
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(
        `⚠️ Failed to read switching state: ${error.message}`
      )
    }

    return {
      nextSwitches: {},
      sentWarnings: [],
    }
  }
}

function saveSwitchingState(state) {
  fs.mkdirSync(path.dirname(SWITCHING_STATE_FILE), {
    recursive: true,
  })

  fs.writeFileSync(
    SWITCHING_STATE_FILE,
    JSON.stringify(state, null, 2)
  )
}

function parseScheduleClock(value) {
  const match = String(value ?? "").match(/^(\d{1,2}):(\d{2})$/)

  if (!match) {
    return null
  }

  const hour = Number(match[1])
  const minute = Number(match[2])

  if (
    minute < 0 ||
    minute > 59 ||
    hour < 0 ||
    hour > 24
  ) {
    return null
  }

  if (hour === 24 && minute !== 0) {
    return null
  }

  return hour * 60 + minute
}

function formatScheduleDateIso(dateKey) {
  const value = String(dateKey).trim()

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value
  }

  if (/^\d{4}\.\d{2}\.\d{2}$/.test(value)) {
    return value.replaceAll(".", "-")
  }

  if (/^\d{2}\.\d{2}\.\d{4}$/.test(value)) {
    const [day, month, year] = value.split(".")
    return `${year}-${month}-${day}`
  }

  if (/^\d{10}$/.test(value)) {
    const date = new Date(Number(value) * 1000)

    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Kyiv",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date)

    const values = Object.fromEntries(
      parts.map(({ type, value }) => [type, value])
    )

    return `${values.year}-${values.month}-${values.day}`
  }

  return null
}

function kyivLocalDateTimeToTimestamp(dateIso, clockValue) {
  const minutes = parseScheduleClock(clockValue)

  if (minutes === null || !dateIso) {
    return null
  }

  const [year, month, day] = dateIso.split("-").map(Number)

  const dayOffset = minutes === 1440 ? 1 : 0
  const normalizedMinutes = minutes === 1440 ? 0 : minutes
  const hour = Math.floor(normalizedMinutes / 60)
  const minute = normalizedMinutes % 60

  const targetUtcLike = Date.UTC(
    year,
    month - 1,
    day + dayOffset,
    hour,
    minute
  )

  // Determine Kyiv's actual UTC offset using its IANA time zone.
  let timestamp = targetUtcLike

  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Kyiv",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp))

    const values = Object.fromEntries(
      parts.map(({ type, value }) => [type, value])
    )

    const representedUtcLike = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute)
    )

    const difference = targetUtcLike - representedUtcLike

    timestamp += difference

    if (difference === 0) {
      break
    }
  }

  return timestamp
}

function compareGroupNumbers(groupA, groupB) {
  const partsA = groupA
    .replace(/^GPV/i, "")
    .split(".")
    .map(Number)

  const partsB = groupB
    .replace(/^GPV/i, "")
    .split(".")
    .map(Number)

  const length = Math.max(partsA.length, partsB.length)

  for (let index = 0; index < length; index++) {
    const a = partsA[index] ?? 0
    const b = partsB[index] ?? 0

    if (a !== b) {
      return a - b
    }
  }

  return 0
}

function getSwitchingEvents(schedules, dateKey, now = new Date()) {
  const dateIso = formatScheduleDateIso(dateKey)

  if (!dateIso) {
    console.warn(
      `⚠️ Cannot parse schedule date for switching alerts: ${dateKey}`
    )
    return []
  }

  const events = schedules.flatMap(({ group, schedule }) => {
    const sorted = [...schedule].sort(
      (a, b) =>
        (parseScheduleClock(a.begin) ?? -1) -
        (parseScheduleClock(b.begin) ?? -1)
    )

    const groupEvents = []

    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1]
      const current = sorted[index]

      if (
        typeof previous.power !== "boolean" ||
        typeof current.power !== "boolean" ||
        previous.power === current.power
      ) {
        continue
      }

      // Ignore gaps in the schedule: only contiguous periods
      // can establish a definite transition.
      const previousEnd = parseScheduleClock(previous.end)
      const currentBegin = parseScheduleClock(current.begin)

      if (
        previousEnd === null ||
        currentBegin === null ||
        previousEnd !== currentBegin
      ) {
        continue
      }

      const timestamp = kyivLocalDateTimeToTimestamp(
        dateIso,
        current.begin
      )

      if (timestamp === null) {
        continue
      }

      const time =
        currentBegin === 1440
          ? "00:00"
          : `${String(Math.floor(currentBegin / 60)).padStart(2, "0")}:${String(currentBegin % 60).padStart(2, "0")}`

      groupEvents.push({
        id: `${dateIso}|${group}|${time}|${current.power ? "ON" : "OFF"}`,
        group,
        time,
        power: current.power,
        timestamp,
        date: dateIso,
      })
    }

    return groupEvents
  })

  // Retain upcoming events and allow a small delay after the exact time.
  return events.filter(
    (event) => event.timestamp > now.getTime() - 60_000
  )
}

async function sendSwitchingMessage(text) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw Error("❌ Missing telegram bot token.")
  }

  if (!TELEGRAM_CHAT_ID) {
    throw Error("❌ Missing telegram chat id.")
  }

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

  const result = await response.json()

  if (!result.ok) {
    throw Error(
      result.description || "Telegram sendMessage failed"
    )
  }

  return result.result
}

async function processSwitchingAlerts(
  schedules,
  dateKey,
  now = new Date()
) {
  const state = loadSwitchingState()
  const events = getSwitchingEvents(schedules, dateKey, now)

  const nowMs = now.getTime()

  const warningWindowMs =
    SWITCHING_WARNING_MINUTES * 60_000

  const correctionWindowMs =
    SWITCHING_CORRECTION_WINDOW_MINUTES * 60_000

  const nextByGroup = {}

  // Find the next transition for every configured group.
  for (const group of TARGET_GROUPS) {
    const next = events
      .filter(
        (event) =>
          event.group === group &&
          event.timestamp > nowMs
      )
      .sort((a, b) => a.timestamp - b.timestamp)[0]

    if (next) {
      nextByGroup[group] = next
    }
  }

  // Notify the chat if an imminent transition has changed.
  let correctionNeeded = false

  for (const [group, previous] of Object.entries(
    state.nextSwitches || {}
  )) {
    if (
      !previous ||
      previous.timestamp <= nowMs ||
      previous.timestamp - nowMs > correctionWindowMs
    ) {
      continue
    }

    const current = nextByGroup[group]

    if (!current || current.id !== previous.id) {
      correctionNeeded = true
      break
    }
  }

  if (correctionNeeded) {
    await sendSwitchingMessage(
      "⚠️ <b>Графік ДТЕК змінився. Час наступного перемикання черг оновлено.</b>"
    )
  }

  const sentWarnings = new Set(state.sentWarnings || [])

  // Only select reminders that are due and have not been sent before.
  const dueEvents = events.filter((event) => {
    const minutesUntil = event.timestamp - nowMs

    return (
      minutesUntil > 0 &&
      minutesUntil <= warningWindowMs &&
      !sentWarnings.has(event.id)
    )
  })

  // Group all due transitions that have the same exact timestamp.
  const eventsByTime = new Map()

  for (const event of dueEvents) {
    if (!eventsByTime.has(event.timestamp)) {
      eventsByTime.set(event.timestamp, [])
    }

    eventsByTime.get(event.timestamp).push(event)
  }

  const sortedTimes = [...eventsByTime.keys()].sort(
    (a, b) => a - b
  )

  for (const timestamp of sortedTimes) {
    const groupedEvents = eventsByTime.get(timestamp)

    // Sort by the numerical queue identifier: 2.2, 3.1, 3.2, etc.
    groupedEvents.sort((a, b) =>
      compareGroupNumbers(a.group, b.group)
    )

    const time = groupedEvents[0].time

    const lines = groupedEvents.map((event) => {
      const displayGroup = event.group.replace(/^GPV/i, "")

      const icon = event.power ? "🔋" : "🪫"

      const action = event.power
        ? "увімкнення"
        : "відключення"

      return `${icon} Черга ${displayGroup} — ${action} світла о <b>${time}</b>`
    })

    const message = [
      "⏰ <b>Нагадування про перемикання</b>",
      "",
      ...lines,
      "",
      "<i>(сьогодні)</i>",
    ].join("\n")

    await sendSwitchingMessage(message)

    // Mark every transition in this message as sent.
    for (const event of groupedEvents) {
      sentWarnings.add(event.id)
    }

    console.log(
      `🟢 Switching reminder sent for ${groupedEvents.length} group(s) at ${time}.`
    )
  }

  state.sentWarnings = [...sentWarnings].slice(-500)
  state.nextSwitches = nextByGroup

  saveSwitchingState(state)
}

async function getShutdownsData() {
  console.log("🌀 Getting shutdowns data...")

  let browser

  try {
    browser = await chromium.launch({ headless: true })

    const browserPage = await browser.newPage()

    await browserPage.goto(SHUTDOWNS_PAGE, {
      waitUntil: "load",
    })

    const html = await browserPage.content()
    const match = html.match(SHUTDOWNS_DATA_MATCHER)

    if (!match) {
      throw new Error(
        "Shutdowns data not found in page HTML"
      )
    }

    const result = JSON.parse(match[1])

    console.log("✅ Getting shutdowns data finished.")

    return result
  } catch (error) {
    console.error(
      `❌ Getting shutdowns data failed: ${error.message}.`
    )
  } finally {
    if (browser) {
      await browser.close()
    }
  }

  if (getShutdownsDataRetries < RETRIES_MAX_COUNT) {
    getShutdownsDataRetries++

    console.log("🌀 Try getting shutdowns data again...")

    await new Promise((resolve) =>
      setTimeout(resolve, RETRIES_TIMEOUT)
    )

    return await getShutdownsData()
  }

  throw Error(
    `❌ Getting shutdowns data failed after ${RETRIES_MAX_COUNT} retries.`
  )
}

function generateSchedule({ data, today, group }) {
  console.log(
    `🌀 Generating schedule for group ${group}...`
  )

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
          setSchedule(
            createPeriod({
              hour,
              power: true,
            })
          )
          break

        case PowerState.OFF:
          setSchedule(
            createPeriod({
              hour,
              power: false,
            })
          )
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

function generateMessage(
  schedules,
  update,
  dateLabel = "сьогодні"
) {
  console.log("🌀 Generating message...")

  const sections = schedules.map(({ group, schedule }) => {
    const displayGroup = group.replace("GPV", "")

    const hasShutdowns = schedule.some(
      ({ power }) => !power
    )

    const scheduleLines = hasShutdowns
      ? schedule
          .filter(({ power }) => !power)
          .map(
            ({ begin, end }) =>
              `🪫 <code>${begin} — ${end}</code>`
          )
      : schedule.map(
          ({ begin, end }) =>
            `🔋 <code>${begin} — ${end}</code>`
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

  const isTomorrow = dateLabel.startsWith("завтра")

  const text = [
    isTomorrow
      ? `📅 <b>⚠️ ГРАФІК ВІДКЛЮЧЕНЬ НА ЗАВТРА (${dateLabel.slice(8).trim()})</b> 📅`
      : `⚡️ <b>Графік відключень на ${dateLabel}:</b>`,
    "",
    ...sections.map(({ text }) => text),
    "",
    `📢 <i>${update ?? "Оновлення сайту ДТЕК"}</i>`,
    `🤖 <i>${getCurrentTime()}</i>`,
  ].join("\n")

  return {
    text,
    scheduleText,
  }
}

async function sendNotification({ text, scheduleText }) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw Error("❌ Missing telegram bot token.")
  }

  if (!TELEGRAM_CHAT_ID) {
    throw Error("❌ Missing telegram chat id.")
  }

  console.log("🌀 Sending today's notification...")

  const lastMessage = loadLastMessage() || {}

  const isScheduleChanged =
    lastMessage.scheduleText !== scheduleText

  const isEdit =
    Boolean(lastMessage.message_id) &&
    !isScheduleChanged

  const isReply =
    Boolean(lastMessage.message_id) &&
    isScheduleChanged

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
      console.log("🟡 Today's notification not changed.")
      return
    }

    if (!result.ok) {
      throw Error(result.description)
    }

    saveLastMessage({
      ...result.result,
      scheduleText,
    })

    console.log("🟢 Today's notification updated.")
  } catch (error) {
    console.error(
      `❌ Sending today's notification failed: ${error.message}.`
    )

    if (sendNotificationRetries < RETRIES_MAX_COUNT) {
      sendNotificationRetries++

      await new Promise((resolve) =>
        setTimeout(resolve, RETRIES_TIMEOUT)
      )

      console.log(
        "🌀 Try sending today's notification again..."
      )

      return await sendNotification({
        text,
        scheduleText,
      })
    }

    throw Error(
      `❌ Sending today's notification failed after ${RETRIES_MAX_COUNT} retries.`
    )
  }
}

async function sendTomorrowNotification({
  text,
  scheduleText,
  scheduleDate,
}) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw Error("❌ Missing telegram bot token.")
  }

  if (!TELEGRAM_CHAT_ID) {
    throw Error("❌ Missing telegram chat id.")
  }

  console.log("🌀 Updating tomorrow's notification...")

  const lastMessage = loadTomorrowMessage() || {}

  const isSameDate =
    lastMessage.scheduleDate === scheduleDate

  const isScheduleChanged =
    !isSameDate ||
    lastMessage.scheduleText !== scheduleText

  const isEdit =
    Boolean(lastMessage.message_id) &&
    isSameDate

  const isReply =
    Boolean(lastMessage.message_id) &&
    isScheduleChanged &&
    isSameDate

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
      console.log(
        "🟡 Tomorrow's notification text is identical; no edit needed."
      )
      return
    }

    if (!result.ok) {
      throw Error(result.description)
    }

    saveTomorrowMessage({
      message_id: result.result.message_id,
      scheduleDate,
      scheduleText,
    })

    console.log("🟢 Tomorrow's notification updated.")
  } catch (error) {
    console.error(
      `❌ Updating tomorrow's notification failed: ${error.message}.`
    )

    if (sendNotificationRetries < RETRIES_MAX_COUNT) {
      sendNotificationRetries++

      await new Promise((resolve) =>
        setTimeout(resolve, RETRIES_TIMEOUT)
      )

      console.log(
        "🌀 Try updating tomorrow's notification again..."
      )

      return await sendTomorrowNotification({
        text,
        scheduleText,
        scheduleDate,
      })
    }

    throw Error(
      `❌ Updating tomorrow's notification failed after ${RETRIES_MAX_COUNT} retries.`
    )
  }
}

function getAvailableSchedules(data, date) {
  const dateData = data[date]

  if (!dateData || !Object.keys(dateData).length) {
    return null
  }

  const availableGroups = TARGET_GROUPS.filter(
    (group) => dateData[group]
  )

  if (!availableGroups.length) {
    return null
  }

  return availableGroups.map((group) => ({
    group,
    schedule: generateSchedule({
      data,
      today: date,
      group,
    }),
  }))
}

function formatScheduleDate(dateKey) {
  const value = String(dateKey).trim()

  // Unix timestamp in seconds.
  if (/^\d{10}$/.test(value)) {
    const date = new Date(Number(value) * 1000)

    return date.toLocaleDateString("uk-UA", {
      timeZone: "Europe/Kyiv",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    })
  }

  let year
  let month
  let day

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    ;[year, month, day] = value.split("-")
  } else if (/^\d{2}\.\d{2}\.\d{4}$/.test(value)) {
    ;[day, month, year] = value.split(".")
  } else if (/^\d{4}\.\d{2}\.\d{2}$/.test(value)) {
    ;[year, month, day] = value.split(".")
  } else {
    console.warn(
      `⚠️ Unrecognized schedule date format: ${value}`
    )
    return value
  }

  return `${day}.${month}.${year}`
}

async function run() {
  console.log("Configured groups:", TARGET_GROUPS)

  const result = await getShutdownsData()

  console.log("Today:", result.today)

  const dates = Object.keys(result.data ?? {}).sort()

  console.log("Available dates:", dates)

  const today = result.today

  const todaySchedules = getAvailableSchedules(
    result.data ?? {},
    today
  )

  if (!todaySchedules) {
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

  await sendNotification(
    generateMessage(
      todaySchedules,
      result.update,
      "сьогодні"
    )
  )

  await processSwitchingAlerts(todaySchedules, today)

  const tomorrow = dates.find((date) => date > today)

  if (!tomorrow) {
    console.log("🟡 No data available for tomorrow.")
    return
  }

  const tomorrowSchedules = getAvailableSchedules(
    result.data ?? {},
    tomorrow
  )

  if (!tomorrowSchedules) {
    console.log(
      "🟡 Tomorrow's schedule has not been published yet."
    )
    return
  }

  const formattedTomorrow = formatScheduleDate(tomorrow)

  const tomorrowMessage = generateMessage(
    tomorrowSchedules,
    result.update,
    `завтра — ${formattedTomorrow}`
  )

  await sendTomorrowNotification({
    ...tomorrowMessage,
    scheduleDate: tomorrow,
  })
}

run().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
