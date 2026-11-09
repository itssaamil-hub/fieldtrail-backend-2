const test=require('node:test');
const assert=require('node:assert/strict');
const {parsePhoto,photoPath,MAX_BYTES}=require('../src/utils/leadPhotos');
const id='a1234567-1234-4234-a234-123456789abc';
test('single path uses employee and client uuid',()=>{
 assert.equal(photoPath(id,id),`${id}/${id}.webp`);
 assert.throws(()=>photoPath('../foo',id));
});
test('photo parser accepts small WebP and rejects non-images or oversized content',()=>{
 const valid=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WEBP'),Buffer.alloc(16)]);
 assert.deepEqual(parsePhoto(valid.toString('base64')),valid);
 assert.equal(parsePhoto(null),null);
 assert.throws(()=>parsePhoto(Buffer.from('not an image').toString('base64')));
 const bad=Buffer.concat([valid,Buffer.alloc(MAX_BYTES)]);
 assert.throws(()=>parsePhoto(bad.toString('base64')));
});
