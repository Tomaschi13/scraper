// Start URL:
// https://www.imdb.com/title/tt1549918/episodes/?season=10
//
// Output table:
// episodes

steps.start = async function start() {
  const cardSelector = ".episode-item-wrapper, .list_item, [data-testid='tab-season-entry']";

  await waitFor(cardSelector, 15000);

  const seasonFromUrl = getSeasonFromUrl();
  const seriesId = pickFirstMatch(location.pathname, /(tt\d+)/i) || "tt1549918";
  const seriesTitle = getSeriesTitle();

  const rows = $(cardSelector)
    .toArray()
    .map(function mapEpisodeCard(card, index) {
      const $card = $(card);
      const lines = getVisibleLines(card);
      const headingText = normalizeText(
        $card.find(".ipc-title__text, .info strong a, .info a[itemprop='name']").first().text()
      );
      const cardText = normalizeText(lines.join(" "));
      const episodeUrl = pickEpisodeUrl($card);
      const imageUrl = pickImageUrl($card);
      const numbers = parseEpisodeNumbers(headingText || cardText, seasonFromUrl, episodeUrl);
      const season = numbers.season || seasonFromUrl || null;
      const episodeNumber = numbers.episode || index + 1;
      const airDate = pickAirDate(lines);
      const ratingText = pickRating(cardText);
      const votes = pickVotes(cardText);
      const episodeTitle =
        parseEpisodeTitle(headingText || cardText) ||
        findTitleFallback(lines, season, episodeNumber) ||
        "";
      const plot =
        normalizeText($card.find(".ipc-html-content-inner-div, .item_description").first().text()) ||
        pickPlot(lines, {
          headingText,
          episodeTitle,
          airDate
        });

      return {
        series_id: seriesId,
        series_title: seriesTitle,
        season,
        episode_number: episodeNumber,
        episode_code: buildEpisodeCode(season, episodeNumber),
        episode_id: pickFirstMatch(episodeUrl, /(tt\d+)/i),
        episode_title: episodeTitle,
        air_date: airDate,
        rating: ratingText ? Number(ratingText) : null,
        votes,
        plot,
        episode_url: episodeUrl,
        image_url: imageUrl,
        card_position: index + 1
      };
    })
    .filter(function keepEpisode(row) {
      return row.episode_title || row.episode_url || row.plot;
    });

  emit("episodes", rows);
  done();
};

function getSeasonFromUrl() {
  const value = new URLSearchParams(location.search).get("season") || "";
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getSeriesTitle() {
  const metaTitle = normalizeText(document.querySelector('meta[property="og:title"]')?.content || "");
  const h1Title = normalizeText($("h1").first().text());
  const base = metaTitle || h1Title || document.title;

  return base
    .replace(/\s*-\s*Episode list\s*-\s*IMDb$/i, "")
    .replace(/\s*-\s*IMDb$/i, "")
    .replace(/\s*\((TV Series|TV Mini Series|TV Special|TV Movie|Podcast Series)[^)]+\)\s*$/i, "")
    .trim();
}

function getVisibleLines(card) {
  return String(card.innerText || "")
    .split("\n")
    .map(normalizeText)
    .filter(Boolean)
    .filter(function keepLine(line, index, lines) {
      if (/^Image:/i.test(line)) {
        return false;
      }

      if (/^Watch options$/i.test(line)) {
        return false;
      }

      if (index > 0 && line === lines[index - 1]) {
        return false;
      }

      return true;
    });
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function pickEpisodeUrl($card) {
  const href = $card
    .find("a[href*='/title/tt']")
    .toArray()
    .map(function mapLink(element) {
      return element.href || "";
    })
    .find(function findEpisodeLink(link) {
      return /\/title\/tt\d+/i.test(link) && !/\/episodes/i.test(link);
    });

  return href ? absoluteUrl(href) : "";
}

function pickImageUrl($card) {
  const image = $card.find("img").first()[0];

  if (!image) {
    return "";
  }

  return absoluteUrl(image.currentSrc || image.src || "");
}

function absoluteUrl(value) {
  if (!value) {
    return "";
  }

  try {
    return new URL(value, location.origin).href;
  } catch (error) {
    return value;
  }
}

function parseEpisodeNumbers(text, seasonDefault, episodeUrl) {
  const source = [text, episodeUrl].filter(Boolean).join(" ");
  let match = source.match(/S(?:eason)?\s*(\d+)\s*\.\s*E(?:pisode)?\s*(\d+)/i);

  if (!match) {
    match = source.match(/S(\d+)\.E(\d+)/i);
  }

  if (match) {
    return {
      season: parseInt(match[1], 10),
      episode: parseInt(match[2], 10)
    };
  }

  match = source.match(/Episode\s+(\d+)/i);
  if (match) {
    return {
      season: seasonDefault,
      episode: parseInt(match[1], 10)
    };
  }

  match = source.match(/ttep_ep_?(\d+)/i);
  if (match) {
    return {
      season: seasonDefault,
      episode: parseInt(match[1], 10)
    };
  }

  return {
    season: seasonDefault,
    episode: null
  };
}

function parseEpisodeTitle(text) {
  const codeMatch = String(text || "").match(/S(?:eason)?\s*\d+\s*\.\s*E(?:pisode)?\s*\d+\s*[^A-Za-z0-9]*\s*(.+)$/i);
  if (codeMatch && codeMatch[1]) {
    return normalizeText(codeMatch[1]);
  }

  const plainMatch = String(text || "").match(/Episode\s+\d+\s*[^A-Za-z0-9]*\s*(.+)$/i);
  if (plainMatch && plainMatch[1]) {
    return normalizeText(plainMatch[1]);
  }

  return "";
}

function findTitleFallback(lines, season, episodeNumber) {
  return lines.find(function findLine(line) {
    if (!line) {
      return false;
    }

    if (line === pickAirDate(lines)) {
      return false;
    }

    if (/\/10\b/i.test(line) || /^Rate$/i.test(line) || /^Top-rated$/i.test(line)) {
      return false;
    }

    if (season && episodeNumber && line === buildEpisodeCode(season, episodeNumber)) {
      return false;
    }

    if (looksLikePlot(line)) {
      return false;
    }

    return line.length > 1 && line.length < 120;
  }) || "";
}

function pickAirDate(lines) {
  return (
    lines.find(function findDate(line) {
      return /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s/i.test(line) ||
        /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}$/i.test(line) ||
        /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s/i.test(line);
    }) || ""
  );
}

function pickRating(text) {
  return pickFirstMatch(text, /(\d+(?:\.\d+)?)\s*\/\s*10\b/i);
}

function pickVotes(text) {
  return (
    pickFirstMatch(text, /\(([\d.,KMBkmb]+)\)\s*Rate\b/i) ||
    pickFirstMatch(text, /(\d[\d.,KMBkmb]*)\s+Rate\b/i) ||
    ""
  );
}

function pickPlot(lines, context) {
  const airDateIndex = context.airDate ? lines.indexOf(context.airDate) : -1;
  const segment = lines
    .slice(airDateIndex + 1)
    .filter(function keepLine(line) {
      if (!line || line === context.headingText || line === context.episodeTitle) {
        return false;
      }

      if (/\/10\b/i.test(line)) {
        return false;
      }

      if (/^Rate$/i.test(line) || /^Top-rated$/i.test(line) || /^Add a plot$/i.test(line)) {
        return false;
      }

      return looksLikePlot(line);
    });

  return segment.join(" ").trim();
}

function looksLikePlot(line) {
  return line.length > 25 && !/^S\d+\.E\d+/i.test(line);
}

function buildEpisodeCode(season, episodeNumber) {
  if (!season || !episodeNumber) {
    return "";
  }

  return "S" + padNumber(season) + "E" + padNumber(episodeNumber);
}

function padNumber(value) {
  const text = String(value || "");
  return text.length >= 2 ? text : "0" + text;
}

function pickFirstMatch(value, pattern) {
  const match = String(value || "").match(pattern);
  return match ? normalizeText(match[1]) : "";
}
