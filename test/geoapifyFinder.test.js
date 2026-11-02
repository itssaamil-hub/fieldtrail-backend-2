const test = require("node:test");
const assert = require("node:assert/strict");
const finder = require("../src/routes/geoapifyFinder");

test("Geoapify categories use provider-supported keys, with strict page offsets", () => {
  assert.equal(finder.CATEGORY_KEYS.restaurant,"catering.restaurant");
  assert.equal(finder.CATEGORY_KEYS.cafe,"catering.cafe");
  assert.equal(finder.CATEGORY_KEYS.bakery,"commercial.food_and_drink.bakery");
  assert.equal(finder.CATEGORY_KEYS.qsr,"catering.fast_food");
  assert.equal(finder.pageOffset(""),0);
  assert.equal(finder.pageOffset("20"),20);
  for(const bad of ["10","1e3","-20","500","99999999999","20&apiKey=leak"]) {
    assert.throws(()=>finder.pageOffset(bad),/Invalid Geoapify page token/);
  }
});

test("Geoapify location search uses server-only key, India's geocoding and bounded places", async () => {
  const saved=process.env.GEOAPIFY_API_KEY;
  process.env.GEOAPIFY_API_KEY="test_secret_never_return";
  const urls=[];
  const fetcher=async (url) => {
    urls.push(new URL(url));
    return {
      ok:true,
      async json(){
        if(urls.length===1) return {results:[{lat:26.868,lon:81.015,country_code:"in",formatted:"Gomti Nagar, Lucknow"}]};
        return {features:[{geometry:{coordinates:[81.015,26.868]},properties:{
          place_id:"known_place_id",name:"Sample Restaurant",formatted:"Lucknow, India"
        }}]};
      }
    };
  };
  try{
    const result=await finder.findRestaurants({city:"Lucknow",area:"Gomti Nagar",category:"restaurant",pageToken:""},fetcher);
    assert.equal(urls.length,2);
    assert.equal(urls[0].hostname,"api.geoapify.com");
    assert.equal(urls[0].pathname,"/v1/geocode/search");
    assert.equal(urls[0].searchParams.get("filter"),"countrycode:in");
    assert.equal(urls[0].searchParams.get("text"),"Gomti Nagar, Lucknow, India");
    assert.equal(urls[1].pathname,"/v2/places");
    assert.equal(urls[1].searchParams.get("filter"),"circle:81.015,26.868,3000");
    assert.equal(urls[1].searchParams.get("categories"),"catering.restaurant");
    assert.equal(urls[1].searchParams.get("offset"),"0");
    assert.equal(result.places.length,1);
    assert.equal(result.places[0].id,"geo_known_place_id");
    assert.match(result.places[0].mapsUrl,/^https:\/\/www\.google\.com\/maps\/search/);
    assert.equal(result.coverage.radiusKm,3);
    assert.equal(result.nextPageToken,null);
    assert.doesNotMatch(JSON.stringify(result),/test_secret_never_return/);
  } finally{
    if(saved===undefined)delete process.env.GEOAPIFY_API_KEY;else process.env.GEOAPIFY_API_KEY=saved;
  }
});

test("No results outside India and no upstream key leakage in error messages", async () => {
  const saved=process.env.GEOAPIFY_API_KEY;
  process.env.GEOAPIFY_API_KEY="test_secret_never_return";
  try{
    await assert.rejects(
      finder.findRestaurants({city:"Unknown",area:"",category:"cafe",pageToken:""},async()=>({ok:true,json:async()=>({results:[]})})),
      /could not locate that area in India/
    );
    const err=await finder.findRestaurants(
      {city:"Lucknow",area:"",category:"cafe",pageToken:""},
      async()=>({ok:false,status:403,json:async()=>({error:"secret test_secret_never_return"})})
    ).then(()=>null,e=>e);
    assert.equal(err.status,503);
    assert.match(err.message,/enable both Places API and Geocoding API/);
    assert.doesNotMatch(err.message,/test_secret_never_return/);
  } finally{
    if(saved===undefined)delete process.env.GEOAPIFY_API_KEY;else process.env.GEOAPIFY_API_KEY=saved;
  }
});

test("Geoapify place mapping excludes unnamed records and keeps required source credit",()=>{
  assert.equal(finder.normalPlace({properties:{place_id:"abc"},geometry:{coordinates:[80,26]}}),null);
  const p=finder.normalPlace({properties:{place_id:"abc",name:"Cafe",formatted:"Lucknow"},geometry:{coordinates:[80,26]}});
  assert.equal(p.name,"Cafe");
  assert.match(p.attributions[0].provider,/OpenStreetMap contributors/);
  assert.equal(p.mapsUrl,"https://www.google.com/maps/search/?api=1&query=26%2C80");
});

test("Geoapify remains restricted to the existing admin route and shared usage ledger",()=>{
  const fs=require("node:fs");
  const src=fs.readFileSync(require.resolve("../src/routes/restaurantFinder.routes"),"utf8");
  assert.match(src,/router\.use\(requireAuth, requireRole\("admin"\)\)/);
  assert.match(src,/geoapify\.findRestaurants\(input\)/);
  assert.match(src,/await usage\("search", true\)/);
  assert.doesNotMatch(src,/localStorage|INSERT INTO leads|INSERT INTO contacts/);
});
