// Start URL:
// https://www.senukai.lt/c/telefonai-plansetiniai-kompiuteriai/mobilieji-telefonai/5nt
//
// Output table:
// products

var ROOT_URL = "https://www.senukai.lt";
var RETAILER = "Senukai";
var COUNTRY_CODE = "LT";
var PAGE_SIZE = 72;
var EMPTY_PRODUCT = {
  retailer: RETAILER,
  cc: COUNTRY_CODE,
  category_url: "",
  breadcrumbs: [],
  page: null,
  position: null,
  name: "",
  brand: "",
  sku: "",
  url: "",
  images: [],
  price: "",
  old_price: "",
  price_label: "",
  offer_info: "",
  availability: true,
  specs: [],
  description: "",
  delivery: "",
  rating: null,
  review_count: null,
  variant_count: 0,
  variant_urls: []
};

steps.start = async function start() {
  setRetries(90000, 2, 500);
  setSettings({ skipVisited: true });

  await wait(1500);

  var categoryUrl = stripPagingParams(location.href);

  next(buildPageUrl(categoryUrl, 1, PAGE_SIZE), "grid", {
    category_url: categoryUrl,
    page_size: PAGE_SIZE
  });

  done(2000);
};

steps.grid = async function grid(params) {
  var cardSelector = "main [data-test='ksd-product-card'], main .catalog-taxons-product";
  var linkSelector = "a[data-test='ksd-link'][href*='/p/'], a.catalog-taxons-product__name[href*='/p/'], a[href*='/p/']";
  var nameSelector = "a[data-test='ksd-link'], a.catalog-taxons-product__name, a[href*='/p/']";
  var breadcrumbSelector = ".breadcrumbs a, .breadcrumbs__item, nav[aria-label*='breadcrumb'] a, [data-test='breadcrumb'] a";
  var paginationSelector =
    "nav[aria-label*='Puslapi'] a[href], nav[aria-label*='pagination'] a[href], .pagination a[href], [class*='pagination'] a[href]";

  await waitFor(cardSelector, 20000);
  await wait(2000);

  var categoryUrl = stripPagingParams(params && params.category_url ? params.category_url : location.href);
  var pageSize = params && params.page_size ? params.page_size : PAGE_SIZE;
  var page = getCurrentPageNumber(location.href);
  var breadcrumbs = Array.from(
    new Set(
      $(breadcrumbSelector)
        .toArray()
        .map(function mapBreadcrumb(item) {
          return normalizeText(item.innerText || $(item).text());
        })
        .filter(function keepBreadcrumb(text) {
          return text && !/^(Pradžia|Home)$/i.test(text);
        })
    )
  );
  var rows = [];
  var seenUrls = new Set();

  $(cardSelector).each(function collectCard(index, card) {
    var $card = $(card);
    var url = "";

    $card.find(linkSelector).each(function findLink(_, link) {
      if (!url) {
        url = canonicalizeProductUrl(link.href || "");
      }
    });

    if (!url || seenUrls.has(url)) {
      return;
    }

    seenUrls.add(url);

    var name = normalizeText($card.find(nameSelector).first().text());
    if (!name) {
      name =
        String(card.innerText || "")
          .split(/\n+/)
          .map(normalizeText)
          .filter(function keepLine(line) {
            return (
              line &&
              line.length > 5 &&
              !/€/.test(line) &&
              !/^(Kaina|Palyginti|Į krepšelį|Pristatym|Atsiėmim|Greitas|Naujiena|SPECIAL)/i.test(line)
            );
          })[0] || "";
    }

    var cardText = normalizeText(card.innerText || $card.text());
    var smartNetMatch = cardText.match(/(?:SMART NET kaina|Lojalumo kaina)\s*([0-9][0-9\s.,]*\s*€)/i);
    var regularMatch = cardText.match(/Įprasta kaina\s*([0-9][0-9\s.,]*\s*€)/i);
    var ePriceMatch = cardText.match(/E\.\s*kaina\s*([0-9][0-9\s.,]*\s*€)/i);
    var firstPriceMatch = cardText.match(/([0-9][0-9\s.,]*\s*€)/);
    var price = "";
    var oldPrice = "";
    var priceLabel = "";

    if (smartNetMatch) {
      price = normalizeText(String(smartNetMatch[1] || "").replace(/\s*\/\s*vnt\.?/gi, ""));
      oldPrice = normalizeText(
        String((regularMatch && regularMatch[1]) || (ePriceMatch && ePriceMatch[1]) || "").replace(/\s*\/\s*vnt\.?/gi, "")
      );
      priceLabel = /SMART NET kaina/i.test(cardText) ? "SMART NET kaina" : "Lojalumo kaina";
    } else if (ePriceMatch) {
      price = normalizeText(String(ePriceMatch[1] || "").replace(/\s*\/\s*vnt\.?/gi, ""));
      oldPrice = normalizeText(String((regularMatch && regularMatch[1]) || "").replace(/\s*\/\s*vnt\.?/gi, ""));
      priceLabel = "E. kaina";
    } else if (regularMatch) {
      price = normalizeText(String(regularMatch[1] || "").replace(/\s*\/\s*vnt\.?/gi, ""));
      priceLabel = "Įprasta kaina";
    } else if (firstPriceMatch) {
      price = normalizeText(String(firstPriceMatch[1] || "").replace(/\s*\/\s*vnt\.?/gi, ""));
      priceLabel = "Kaina";
    }

    var specs = Array.from(
      new Set(
        $card
          .find("li")
          .toArray()
          .map(function mapSpec(item) {
            return normalizeText(item.innerText || $(item).text());
          })
          .filter(function keepSpec(line) {
            return /:\s*\S/.test(line) && !/kaina|variant|prekės kodas/i.test(line);
          })
      )
    ).slice(0, 8);

    if (!specs.length) {
      specs = Array.from(
        new Set(
          String(card.innerText || "")
            .split(/\n+/)
            .map(normalizeText)
            .filter(function keepFallbackSpec(line) {
              return /:\s*\S/.test(line) && !/kaina|variant|prekės kodas/i.test(line);
            })
        )
      ).slice(0, 8);
    }

    var image = "";
    $card.find("img").each(function findImage(_, img) {
      if (image) {
        return;
      }

      var source = canonicalizeUrl(
        img.currentSrc || $(img).attr("src") || $(img).attr("data-src") || $(img).attr("data-original") || ""
      );

      if (
        source &&
        !/(badge-icon|logo|icon|sprite|placeholder|attributionlogo|bazaarvoice)/i.test(source) &&
        !/\/display$/i.test(source)
      ) {
        image = source;
      }
    });

    var offerInfo = [
      "SPECIAL 24",
      "0 % PABRANGIMAS 24 MĖN.",
      "E. kaina",
      "Naujiena",
      "SMART NET kaina",
      "Lojalumo kaina",
      "Komplektacijoje nėra įkroviklio"
    ].filter(function keepTag(tag) {
      return cardText.toLowerCase().indexOf(tag.toLowerCase()) !== -1;
    });

    var delivery =
      String(card.innerText || "")
        .split(/\n+/)
        .map(normalizeText)
        .find(function findDelivery(line) {
          return /(Greitas atsiėmimas|Pristatymas į namus|Atsiėmimas paštomate)/i.test(line);
        }) || "";

    var variantMatch = cardText.match(/\+\s*(\d+)\s*variant/i);

    rows.push(
      Object.assign({}, EMPTY_PRODUCT, {
        category_url: categoryUrl,
        breadcrumbs: breadcrumbs,
        page: page,
        position: index + 1,
        name: name,
        sku: normalizeText(
          $card.find("[data-compare-product-id]").attr("data-compare-product-id") ||
            $card.find("[data-product-id]").attr("data-product-id") ||
            ""
        ),
        url: url,
        images: image ? [image] : [],
        price: price,
        old_price: oldPrice,
        price_label: priceLabel,
        offer_info: offerInfo.join(", "),
        availability: !/(Pranešti kai turėsime|Neturime|Nėra sandėlyje|Išparduota|Nepasiekiama)/i.test(cardText),
        specs: specs,
        delivery: delivery,
        variant_count: variantMatch ? parseInt(variantMatch[1], 10) : 0,
        variant_urls: [url]
      })
    );
  });

  if (!rows.length) {
    throw new Error("No Senukai products were found on the category page.");
  }

  var nextPageUrl = "";

  $(paginationSelector).each(function findNextPage(_, link) {
    if (nextPageUrl) {
      return;
    }

    var href = withPageSize(link.href || "", pageSize);
    if (!href) {
      return;
    }

    try {
      var parsed = new URL(href, ROOT_URL);
      var nextPage = parseInt(parsed.searchParams.get("page") || "1", 10);

      if (parsed.origin === ROOT_URL && stripPagingParams(parsed.href) === categoryUrl && nextPage === page + 1) {
        nextPageUrl = parsed.href;
      }
    } catch (error) {
      return;
    }
  });

  if (!nextPageUrl) {
    var totalMatch = normalizeText(document.body ? document.body.innerText : "").match(/([\d\s]+)\s+prek(?:ė|ės|iu|ių)/i);
    var totalProducts = totalMatch ? parseInt(String(totalMatch[1] || "").replace(/\D/g, ""), 10) : 0;

    if (totalProducts > page * pageSize) {
      nextPageUrl = buildPageUrl(categoryUrl, page + 1, pageSize);
    }
  }

  if (nextPageUrl) {
    next(nextPageUrl, "grid", {
      category_url: categoryUrl,
      page_size: pageSize
    });
  }

  rows
    .slice()
    .reverse()
    .forEach(function queueProduct(row) {
      next(row.url, "product_page", row);
    });

  done(2000);
};

steps.product_page = async function product_page(seed) {
  var nameSelector = "h1, [itemprop='name'], [data-test='product-name'], .product-name";
  var codeSelector = ".product-id, [data-test='product-code'], [data-product-id]";
  var specSelector = ".info-table tr:not(.group-title-row), [data-test='product-attributes'] tr, table tr, dl > div";
  var descriptionSelector = "#FullInpageHtml, .product-description, [data-test='product-description'], .products-description";
  var breadcrumbSelector = ".breadcrumbs a, .breadcrumbs__item, nav[aria-label*='breadcrumb'] a, [data-test='breadcrumb'] a";
  var breadcrumbLinkSelector = ".breadcrumbs a[href], nav[aria-label*='breadcrumb'] a[href], [data-test='breadcrumb'] a[href]";
  var imageSelector =
    "[data-test='product-gallery'] img, .product-gallery img, [class*='gallery'] img, [class*='product-image'] img, main img";
  var ratingSelector = "[itemprop='ratingValue'], [data-bv-rating], .rating-summary [class*='rating'], [data-test='rating-value']";
  var reviewSelector = "[itemprop='reviewCount'], .bv_numReviews_text, [data-test='rating-count']";
  var variantSelector =
    "[data-test*='variant'] a[href*='/p/'], [class*='variant'] a[href*='/p/'], [class*='swatch'] a[href*='/p/'], [class*='option'] a[href*='/p/'], [aria-label*='Spalv'] a[href*='/p/'], [aria-label*='Atmint'] a[href*='/p/'], [aria-label*='Talp'] a[href*='/p/']";
  var row = Object.assign({}, EMPTY_PRODUCT, seed || {});

  try {
    await waitFor(nameSelector + ", " + specSelector + ", " + descriptionSelector, 12000);
  } catch (error) {
    // Emit the seeded row if the product page never fully stabilizes.
  }

  await wait(2500);

  var pageText = normalizeText(document.body ? document.body.innerText : "");
  var pageLines = String(document.body ? document.body.innerText : "")
    .split(/\n+/)
    .map(normalizeText)
    .filter(Boolean);
  var name = normalizeText($(nameSelector).first().text());
  var rawCode = normalizeText($(codeSelector).first().text() || $(codeSelector).first().attr("data-product-id") || "");
  var codeMatch = rawCode.match(/(\d{6,})/);
  var sku = codeMatch ? codeMatch[1] : ((pageText.match(/Prekės kodas\s*:?\s*(\d{6,})/i) || [])[1] || "");
  var pageLooksBroken =
    /(Puslapis nerastas|404|Apgailestaujame|Nepavyko rasti|Prekė nerasta|Produktas nepasiekiamas)/i.test(pageText) ||
    /\/c\//.test(location.pathname);
  var hasProductSignals = Boolean(name || sku || $(specSelector).length || /€/.test(pageText));

  row.url = canonicalizeProductUrl(location.href) || row.url;

  if (pageLooksBroken || !hasProductSignals) {
    row.variant_urls = row.variant_urls && row.variant_urls.length ? row.variant_urls : row.url ? [row.url] : [];
    row.variant_count = Math.max(row.variant_count || 0, Math.max(row.variant_urls.length - 1, 0));
    emit("products", [row]);
    done(2500);
    return;
  }

  var breadcrumbs = Array.from(
    new Set(
      $(breadcrumbSelector)
        .toArray()
        .map(function mapBreadcrumb(item) {
          return normalizeText(item.innerText || $(item).text());
        })
        .filter(function keepBreadcrumb(text) {
          return text && !/^(Pradžia|Home)$/i.test(text);
        })
    )
  );
  var categoryLinks = Array.from(
    new Set(
      $(breadcrumbLinkSelector)
        .toArray()
        .map(function mapLink(link) {
          return canonicalizeUrl(link.href || "");
        })
        .filter(function keepLink(href) {
          return /\/c\//.test(href);
        })
    )
  );
  var smartNetMatch = pageText.match(/(?:SMART NET kaina|Lojalumo kaina)\s*([0-9][0-9\s.,]*\s*€)/i);
  var regularMatch = pageText.match(/Įprasta kaina\s*([0-9][0-9\s.,]*\s*€)/i);
  var ePriceMatch = pageText.match(/E\.\s*kaina\s*([0-9][0-9\s.,]*\s*€)/i);
  var firstPriceMatch = pageText.match(/([0-9][0-9\s.,]*\s*€)/);
  var price = row.price;
  var oldPrice = row.old_price;
  var priceLabel = row.price_label;

  if (smartNetMatch) {
    price = normalizeText(String(smartNetMatch[1] || "").replace(/\s*\/\s*vnt\.?/gi, ""));
    oldPrice = normalizeText(
      String((regularMatch && regularMatch[1]) || (ePriceMatch && ePriceMatch[1]) || "").replace(/\s*\/\s*vnt\.?/gi, "")
    );
    priceLabel = /SMART NET kaina/i.test(pageText) ? "SMART NET kaina" : "Lojalumo kaina";
  } else if (ePriceMatch) {
    price = normalizeText(String(ePriceMatch[1] || "").replace(/\s*\/\s*vnt\.?/gi, ""));
    oldPrice = normalizeText(String((regularMatch && regularMatch[1]) || "").replace(/\s*\/\s*vnt\.?/gi, ""));
    priceLabel = "E. kaina";
  } else if (regularMatch) {
    price = normalizeText(String(regularMatch[1] || "").replace(/\s*\/\s*vnt\.?/gi, ""));
    oldPrice = "";
    priceLabel = "Įprasta kaina";
  } else if (firstPriceMatch) {
    price = normalizeText(String(firstPriceMatch[1] || "").replace(/\s*\/\s*vnt\.?/gi, ""));
    oldPrice = row.old_price;
    priceLabel = row.price_label || "Kaina";
  }

  var specs = [];
  var brand = "";

  $(specSelector).each(function collectSpec(_, item) {
    var key = "";
    var value = "";

    if ($(item).is("tr")) {
      key = normalizeText($(item).find("th, td").first().text());
      value = normalizeText($(item).find("td").last().text());
    } else {
      key = normalizeText($(item).find("dt").first().text());
      value = normalizeText($(item).find("dd").first().text());
    }

    if (!key || !value || key === value || /kaina|variant|prekės kodas/i.test(key + " " + value)) {
      return;
    }

    specs.push(key + ": " + value);

    if (!brand && /^Prekės ženklas$/i.test(key)) {
      brand = value;
    }
  });

  specs = Array.from(new Set(specs));

  if (!specs.length) {
    var inSpecs = false;

    for (var i = 0; i < pageLines.length; i += 1) {
      var line = pageLines[i];

      if (!inSpecs) {
        if (/Gaminio savybės/i.test(line)) {
          inSpecs = true;
        }
        continue;
      }

      if (/Gaminio aprašymas|Pastebėjai klaidą|Dažnai perkama kartu|Panašios prekės/i.test(line)) {
        break;
      }

      if (/^(Visos gaminio savybės|Prekės informacija|Gaminio savybės)$/i.test(line)) {
        continue;
      }

      var nextLine = pageLines[i + 1] || "";
      if (line && nextLine && line !== nextLine && !/[:=]/.test(line) && !/^\d+$/.test(line)) {
        specs.push(line + ": " + nextLine);
        i += 1;
      }
    }

    specs = Array.from(new Set(specs));

    var brandLine = specs.find(function findBrand(line) {
      return /^Prekės ženklas:/i.test(line);
    });

    if (!brandLine) {
      brandLine = specs.find(function findBrandAlias(line) {
        return /^Brand:/i.test(line);
      });
    }

    if (brandLine && !brand) {
      brand = normalizeText(brandLine.replace(/^[^:]+:\s*/i, ""));
    }
  }

  var description = "";

  $(descriptionSelector).each(function collectDescription(_, element) {
    var text = normalizeText($(element).text());
    if (text.length > description.length) {
      description = text;
    }
  });

  if (!description) {
    var descriptionLines = [];
    var inDescription = false;

    for (var j = 0; j < pageLines.length; j += 1) {
      var descriptionLine = pageLines[j];

      if (!inDescription) {
        if (/Gaminio aprašymas/i.test(descriptionLine)) {
          inDescription = true;
        }
        continue;
      }

      if (/Panašios prekės|Dažnai perkama kartu|Internetinė parduotuvė/i.test(descriptionLine)) {
        break;
      }

      descriptionLines.push(descriptionLine);
    }

    description = normalizeText(descriptionLines.join(" "));
  }

  var deliveryLines = [];
  var inDelivery = false;

  for (var k = 0; k < pageLines.length; k += 1) {
    var deliveryLine = pageLines[k];

    if (!inDelivery) {
      if (/Pristatymo galimybės/i.test(deliveryLine)) {
        inDelivery = true;
      }
      continue;
    }

    if (/Likutis fizinėse parduotuvėse|Dažnai perkama kartu|Prekės informacija/i.test(deliveryLine)) {
      break;
    }

    if (deliveryLine && !/^\*+$/.test(deliveryLine) && !/^Rekomenduojame$/i.test(deliveryLine)) {
      deliveryLines.push(deliveryLine);
    }
  }

  var images = [];

  $(imageSelector).each(function collectImage(_, img) {
    var source = canonicalizeUrl(
      img.currentSrc || $(img).attr("src") || $(img).attr("data-src") || $(img).attr("data-original") || ""
    );

    if (
      source &&
      images.indexOf(source) === -1 &&
      !/(badge-icon|logo|icon|sprite|placeholder|attributionlogo|bazaarvoice)/i.test(source) &&
      !/\/display$/i.test(source)
    ) {
      images.push(source);
    }
  });

  var ratingText = normalizeText($(ratingSelector).first().text() || $(ratingSelector).first().attr("content") || "");
  var reviewText = normalizeText($(reviewSelector).first().text() || $(reviewSelector).first().attr("content") || "");

  if (!ratingText) {
    ratingText = (pageText.match(/(\d+(?:[.,]\d+)?)\s*\/\s*5/) || [])[1] || "";
  }

  if (!reviewText) {
    reviewText = (pageText.match(/(\d[\d\s.,]*)\s+(?:atsiliepim|review)/i) || [])[1] || "";
  }

  var variantUrls = [];

  $(variantSelector).each(function collectVariant(_, link) {
    var href = canonicalizeProductUrl(link.href || "");
    if (href && variantUrls.indexOf(href) === -1) {
      variantUrls.push(href);
    }
  });

  if (row.url && variantUrls.indexOf(row.url) === -1) {
    variantUrls.unshift(row.url);
  }

  var offerInfo = [
    "SPECIAL 24",
    "0 % PABRANGIMAS 24 MĖN.",
    "E. kaina",
    "Naujiena",
    "SMART NET kaina",
    "Lojalumo kaina",
    "Komplektacijoje nėra įkroviklio"
  ].filter(function keepTag(tag) {
    return pageText.toLowerCase().indexOf(tag.toLowerCase()) !== -1;
  });

  row.category_url = row.category_url || (categoryLinks.length ? stripPagingParams(categoryLinks[categoryLinks.length - 1]) : "");
  row.breadcrumbs = breadcrumbs.length ? breadcrumbs : row.breadcrumbs;
  row.name = name || row.name;
  row.brand = brand || row.brand;
  row.sku = sku || row.sku;
  row.images = images.length ? images.slice(0, 12) : row.images;
  row.price = price || row.price;
  row.old_price = oldPrice || row.old_price;
  row.price_label = priceLabel || row.price_label;
  row.offer_info = Array.from(new Set([row.offer_info].concat(offerInfo).filter(Boolean))).join(", ");
  row.availability = !/(Pranešti kai turėsime|Neturime|Nėra sandėlyje|Išparduota|Nepasiekiama|Produktas nepasiekiamas)/i.test(pageText);
  row.specs = specs.length ? specs : row.specs;
  row.description = description || row.description;
  row.delivery = deliveryLines.slice(0, 12).join(" | ") || row.delivery;
  row.rating = ratingText ? parseFloat(String(ratingText).replace(",", ".")) : row.rating;
  row.review_count = reviewText ? parseInt(String(reviewText).replace(/\D/g, ""), 10) : row.review_count;
  row.variant_urls = variantUrls.length ? variantUrls : row.variant_urls && row.variant_urls.length ? row.variant_urls : row.url ? [row.url] : [];
  row.variant_count = Math.max(row.variant_count || 0, Math.max(row.variant_urls.length - 1, 0));

  emit("products", [row]);
  done(2500);
};

function getCurrentPageNumber(url) {
  try {
    var parsed = new URL(url, ROOT_URL);
    var page = parseInt(parsed.searchParams.get("page") || "1", 10);
    return Number.isFinite(page) && page > 0 ? page : 1;
  } catch (error) {
    return 1;
  }
}

function withPageSize(url, pageSize) {
  try {
    var parsed = new URL(url, ROOT_URL);
    parsed.searchParams.set("page_per", String(pageSize || PAGE_SIZE));
    return parsed.href;
  } catch (error) {
    return "";
  }
}

function buildPageUrl(categoryUrl, pageNumber, pageSize) {
  try {
    var parsed = new URL(categoryUrl, ROOT_URL);
    parsed.searchParams.set("page", String(pageNumber));
    parsed.searchParams.set("page_per", String(pageSize || PAGE_SIZE));
    return parsed.href;
  } catch (error) {
    return "";
  }
}

function stripPagingParams(url) {
  try {
    var parsed = new URL(url, ROOT_URL);
    parsed.searchParams.delete("page");
    parsed.searchParams.delete("page_per");
    parsed.hash = "";
    return parsed.href;
  } catch (error) {
    return url || "";
  }
}

function canonicalizeProductUrl(url) {
  var normalized = canonicalizeUrl(url);
  return /\/p\//.test(normalized) ? normalized : "";
}

function canonicalizeUrl(url) {
  if (!url) {
    return "";
  }

  try {
    var parsed = new URL(url, ROOT_URL);
    parsed.hash = "";
    return parsed.href;
  } catch (error) {
    return "";
  }
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
