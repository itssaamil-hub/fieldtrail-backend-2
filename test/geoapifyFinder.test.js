const test = require("node:test");
const assert = require("node:assert/strict");
const finder = require("../src/routes/geoapifyFinder");

test("Geoapify categories use provider-supported keys, with strict page offsets", () => {
  assert.equal(finder.CATEGORY_KEYS.all,"catering.restaurant,catering.cafe,commercial.food_and_drink.bakery");
  assert.equal(finder.CATEGORY_KEYS.premium,"catering.restaurant");
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

test("Selected Geoapify radius is applied exactly; premium results are candidates only", async () => {
  const previous=process.env.GEOAPIFY_API_KEY;
  process.env.GEOAPIFY_API_KEY="test_only_secret";
  const queries=[];
  const fetcher=async url=>{
    queries.push(new URL(url));
    return {ok:true,json:async()=>queries.length===1
      ?{results:[{lat:26.85,lon:80.94,country_code:"in",formatted:"Hazratganj, Lucknow"}]}
      :{features:[
        {geometry:{coordinates:[80.94,26.85]},properties:{place_id:"ordinary",name:"Neighborhood Kitchen",categories:["catering.restaurant.indian"]}},
        {geometry:{coordinates:[80.941,26.851]},properties:{place_id:"premium",name:"The Fine Dining Room",categories:["catering.restaurant"]}}
      ]}};
  };
  try {
    const result=await finder.findRestaurants({city:"Lucknow",area:"Hazratganj",category:"premium",radiusKm:20,pageToken:""},fetcher);
    assert.equal(queries.length,2);
    assert.equal(queries[1].searchParams.get("categories"),"catering.restaurant");
    assert.equal(queries[1].searchParams.get("filter"),"circle:80.94,26.85,20000");
    assert.equal(result.coverage.radiusKm,20);
    assert.equal(result.places[0].name,"The Fine Dining Room");
    assert.equal(result.places[0].premiumCandidate,true);
    assert.match(result.places[0].premiumHint,/Name suggests/);
    assert.equal(result.places[1].premiumCandidate,false);
    assert.equal(result.places[1].premiumHint,null);
    assert.doesNotMatch(JSON.stringify(result),/test_only_secret/);
    assert.match(result.places[0].attributions[0].provider,/OpenStreetMap contributors/);
  } finally {
    if(previous===undefined)delete process.env.GEOAPIFY_API_KEY;
    else process.env.GEOAPIFY_API_KEY=previous;
  }
});

test("No invented premium certainty from ordinary restaurant or cuisine alone",()=>{
  assert.equal(finder.premiumEvidence({name:"Biryani House",categories:["catering.restaurant.indian"]}),null);
  assert.match(finder.premiumEvidence({name:"French Cuisine",categories:["catering.restaurant.french"]}),/may indicate/);
  assert.throws(()=>finder.pageOffset("20&radius=200000"),/Invalid Geoapify page token/);
});
