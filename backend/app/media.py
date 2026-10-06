import asyncio
import json
import math
import re
import time
from pathlib import Path
import pysubs2
from . import store as s
from .models import Edit

TEXT_SUBS = {'subrip','ass','ssa','mov_text','webvtt','text'}
class Cancelled(Exception):
    pass

def cancelled(ident):
    row = s.one('SELECT status FROM jobs WHERE id=?', (ident,))
    return not row or row['status'] == 'cancelled'

async def run(args, ident=None, duration=0):
    # Media operations never need network protocols or executable input helpers.
    if args[0]=='ffmpeg':
        args=[args[0],'-protocol_whitelist','file,pipe',*args[1:]]
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    errors = bytearray()
    async def drain():
        while chunk := await proc.stderr.read(4096):
            errors.extend(chunk)
            if len(errors) > 16000:
                del errors[:-16000]
    err_task = asyncio.create_task(drain())
    async def read_progress():
        while line := await proc.stdout.readline():
            if ident and duration and line.startswith(b'out_time_us='):
                try:
                    elapsed = int(line.split(b'=')[1]) / 1e6
                    s.update_job(ident, progress=min(99, elapsed / duration * 100))
                except ValueError:
                    pass
    stdout_task = asyncio.create_task(read_progress())
    try:
        while proc.returncode is None:
            if ident and cancelled(ident):
                raise Cancelled()
            try:
                await asyncio.wait_for(proc.wait(), 0.3)
            except asyncio.TimeoutError:
                continue
        await stdout_task
        await err_task
        if proc.returncode:
            # Commands use only managed local files; never include network URLs in diagnostics.
            message = errors.decode(errors='replace')[-1500:]
            message = message.replace(str(s.DATA), '[media]')
            raise ValueError('Media processing failed: ' + message)
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        await asyncio.gather(err_task, stdout_task, return_exceptions=True)

async def probe(path):
    proc = await asyncio.create_subprocess_exec('ffprobe','-v','error','-protocol_whitelist','file,pipe','-show_format','-show_streams','-of','json',str(path),
                                              stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), 60)
    except BaseException:
        proc.kill()
        await proc.wait()
        raise
    if proc.returncode:
        raise ValueError('This file could not be read as valid media.')
    data = json.loads(out)
    streams = data.get('streams', [])
    video = next((st for st in streams if st['codec_type']=='video' and not st.get('disposition',{}).get('attached_pic')), None)
    audio = [st for st in streams if st['codec_type']=='audio']
    def track(st):
        return {'index':st['index'], 'codec':st.get('codec_name','unknown'),
                'language':st.get('tags',{}).get('language',''), 'title':st.get('tags',{}).get('title','')}
    width,height=(video.get('width',0),video.get('height',0)) if video else (0,0)
    rotation=next((item.get('rotation',0) for item in video.get('side_data_list',[]) if 'rotation' in item),0) if video else 0
    if round(abs(float(rotation)))%180==90:
        width,height=height,width
    return {'duration':float(data.get('format',{}).get('duration',0)),
            'size':Path(path).stat().st_size, 'width':width,
            'height':height, 'video_codec':video.get('codec_name') if video else None,
            'format':data.get('format',{}).get('format_name',''), 'audio':[track(st) for st in audio],
            'subtitles':[{**track(st),'editable':st.get('codec_name') in TEXT_SUBS} for st in streams if st['codec_type']=='subtitle']}

async def add_subtitle(project_id, path, title, language='', codec='subrip', original_ass=None):
    try:
        subs = await asyncio.to_thread(pysubs2.load, str(path), encoding='utf-8-sig')
    except Exception:
        raise ValueError('Could not read subtitles. Upload UTF-8 SRT, VTT, ASS or SSA text subtitles.')
    if len(subs) > 30000:
        raise ValueError('This subtitle file has too many cues (maximum 30,000).')
    cues = [{'start':max(0,event.start / 1000),'end':max(0,event.end / 1000),'text':event.plaintext} for event in subs if event.end > event.start]
    ident = s.uid()
    ass = None
    if codec in ('ass','ssa'):
        ass = str(s.DATA / 'subtitles' / (ident+'.ass'))
        await asyncio.to_thread(subs.save, ass)
    s.execute('INSERT INTO subtitles VALUES (?,?,?,?,?,?,?,?)',
              (ident,project_id,title[:150],language,codec,json.dumps(cues),ass,1))
    return ident

async def ingest(project_id, path, ident):
    with Path(path).open('rb') as f:
        header=f.read(32)
    if not (header[:4]==b'\x1aE\xdf\xa3' or header[4:8] in (b'ftyp',b'moov',b'mdat',b'wide',b'free')):
        raise ValueError('The source is not a supported MP4, MKV or WebM video file.')
    meta = await probe(path)
    if not meta['video_codec'] or meta['duration'] <= 0:
        raise ValueError('Choose a video with a readable duration and video stream.')
    s.execute('UPDATE projects SET source=?, metadata=?, status=? WHERE id=?', (str(path),json.dumps(meta),'processing',project_id))
    for track in meta['subtitles']:
        title = track['title'] or (track['language'] or 'Subtitle') + ' · ' + track['codec']
        if not track['editable']:
            s.execute('INSERT INTO subtitles VALUES (?,?,?,?,?,?,?,?)', (s.uid(),project_id,title,track['language'],track['codec'],'[]',None,0))
            continue
        extension = '.ass' if track['codec'] in ('ass','ssa') else '.srt'
        dest = s.DATA / 'work' / (s.uid()+extension)
        try:
            await run(['ffmpeg','-v','error','-y','-i',str(path),'-map',f"0:{track['index']}",str(dest)],ident)
            await add_subtitle(project_id,dest,title,track['language'],track['codec'])
        finally:
            dest.unlink(missing_ok=True)
    tracks = s.rows('SELECT id FROM subtitles WHERE project_id=? AND editable=1', (project_id,))
    edit = Edit(end=meta['duration']).model_dump()
    if tracks:
        edit['subtitles']['track_id'] = tracks[0]['id']
    s.execute('UPDATE projects SET edit=? WHERE id=?', (json.dumps(edit),project_id))
    thumb = s.DATA / 'previews' / (project_id+'.jpg')
    try:
        await run(['ffmpeg','-v','error','-y','-ss',str(min(1,meta['duration']/2)),'-i',str(path),'-frames:v','1','-vf','scale=640:-2',str(thumb)],ident)
        s.execute('UPDATE projects SET thumbnail=? WHERE id=?', (str(thumb),project_id))
    except ValueError:
        pass
    s.job('proxy',project_id,{'audio_track':0})

async def proxy(project, payload, ident):
    meta = json.loads(project['metadata'])
    audio_track = int(payload.get('audio_track',0))
    if meta['audio'] and audio_track >= len(meta['audio']):
        raise ValueError('That audio track does not exist.')
    dest = s.DATA / 'previews' / (project['id']+f'-a{audio_track}.mp4')
    if dest.exists():
        s.execute('UPDATE projects SET preview=?,status=? WHERE id=?',(str(dest),'ready',project['id']))
        return
    temp = dest.with_suffix('.part.mp4')
    args = ['ffmpeg','-hide_banner','-v','error','-y','-i',project['source'],'-map','0:v:0']
    if meta['audio']:
        args += ['-map',f'0:a:{audio_track}']
    args += ['-vf',"scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",'-c:v','libx264','-preset','ultrafast','-crf','25','-threads','3','-c:a','aac','-b:a','128k','-pix_fmt','yuv420p','-movflags','+faststart','-progress','pipe:1','-nostats',str(temp)]
    try:
        s.space_for(max(meta['size']//2,50*1024**2))
        await run(args,ident,meta['duration'])
        temp.replace(dest)
        s.execute('UPDATE projects SET preview=?,status=? WHERE id=?', (str(dest),'ready',project['id']))
    finally:
        temp.unlink(missing_ok=True)


def dimensions(meta, edit):
    ratio = meta['width']/meta['height'] if edit.crop.ratio=='original' else float(edit.crop.ratio.split(':')[0])/float(edit.crop.ratio.split(':')[1])
    longest = edit.resolution
    if ratio >= 1:
        w,h = longest, round(longest/ratio/2)*2
    else:
        w,h = round(longest*ratio/2)*2,longest
    return max(2,w),max(2,h)

def ass_color(color, opacity=1):
    return pysubs2.Color(int(color[1:3],16),int(color[3:5],16),int(color[5:7],16),round((1-opacity)*255))

def make_subs(project_id, edit, start, end, w, h, work, snapshot=None):
    style = edit.subtitles
    row = snapshot or s.one('SELECT * FROM subtitles WHERE id=? AND project_id=?', (style.track_id,project_id))
    if not row:
        raise ValueError('The selected subtitle track no longer exists.')
    if not row['editable']:
        raise ValueError('Image subtitles cannot be edited or burned in. Upload text subtitles instead.')
    if style.preserve_ass and row['ass_path']:
        subs = pysubs2.load(row['ass_path'])
    else:
        subs = pysubs2.SSAFile()
        subs.info['PlayResX'], subs.info['PlayResY'] = str(w),str(h)
        scale = h/1080
        alignment = {'bottom':0,'middle':3,'top':6}[style.position] + {'left':1,'center':2,'right':3}[style.align]
        substyle = pysubs2.SSAStyle(fontname=style.font,fontsize=style.size*scale,
            primarycolor=ass_color(style.color), outlinecolor=ass_color(style.outline_color),
            backcolor=ass_color('#000000',style.box_opacity if style.box else 0.6),
            outline=style.outline*scale,shadow=style.shadow*scale,borderstyle=3 if style.box else 1,
            alignment=pysubs2.Alignment(alignment),marginl=round(style.margin*scale),marginr=round(style.margin*scale),marginv=round(style.margin*scale))
        # Opaque boxes use OutlineColour in libass.
        if style.box:
            substyle.outlinecolor = ass_color(style.outline_color, style.box_opacity)
        subs.styles['Default'] = substyle
        for cue in json.loads(row['cues']):
            text = cue['text'].replace('{','｛').replace('}','｝').replace('\\','＼').replace('\n',r'\N')
            subs.events.append(pysubs2.SSAEvent(start=round(cue['start']*1000),end=round(cue['end']*1000),text=text))
    events = []
    for event in subs:
        a,b = event.start/1000+style.offset, event.end/1000+style.offset
        if b > start and a < end:
            event.start = round((max(a,start)-start)*1000)
            event.end = round((min(b,end)-start)*1000)
            events.append(event)
    subs.events = events
    dest = work / 'captions.ass'
    subs.save(str(dest))
    return dest

def filter_path(path):
    return str(path).replace('\\','\\\\').replace(':',r'\:').replace("'",r"\'")

async def render(project, payload, ident):
    edit = Edit.model_validate(payload['edit'])
    meta = json.loads(project['metadata'])
    if edit.end <= edit.start or edit.end > meta['duration']+0.05:
        raise ValueError('The clip end must follow the start and stay inside the video.')
    preview = bool(payload.get('preview'))
    duration = min(edit.end-edit.start,6) if preview else edit.end-edit.start
    w,h = dimensions(meta,edit)
    work = s.DATA / 'work' / ident
    work.mkdir(exist_ok=True)
    clip_id = s.uid()
    dest = s.DATA / 'renders' / (clip_id+'.mp4')
    s.space_for(max(50*1024**2,int(duration*w*h/3)))
    args = ['ffmpeg','-hide_banner','-v','error','-y','-ss',str(edit.start),'-i',project['source']]
    filters=[]
    wm = edit.watermark
    next_input = 1
    image_index = None
    if wm.kind=='image':
        asset = s.one("SELECT * FROM assets WHERE id=? AND project_id=? AND kind='watermark'", (wm.asset_id,project['id']))
        if not asset:
            raise ValueError('Upload a watermark image first.')
        image_index=next_input
        next_input += 1
        args += ['-loop','1','-i',asset['path']]
    music_index = None
    if edit.audio.music_id:
        asset = s.one("SELECT * FROM assets WHERE id=? AND project_id=? AND kind='music'", (edit.audio.music_id,project['id']))
        if not asset:
            raise ValueError('The background music no longer exists.')
        music_index=next_input
        args += ['-stream_loop','-1','-i',asset['path']]
    crop=edit.crop
    if crop.mode=='fill':
        vf=f'scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}:(iw-ow)*{crop.x}:(ih-oh)*{crop.y},setsar=1'
    else:
        vf=f'scale={w}:{h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={w}:{h}:(ow-iw)*{crop.x}:(oh-ih)*{crop.y}:black,setsar=1'
    if edit.subtitles.burn and edit.subtitles.track_id:
        subs=make_subs(project['id'],edit,edit.start,edit.start+duration,w,h,work,payload.get('subtitle_snapshot'))
        vf+=f",ass=filename='{filter_path(subs)}'"
    visibility_end = duration if wm.end is None else min(wm.end,duration)
    enable=f"between(t,{wm.start},{visibility_end})"
    if wm.kind=='text' and wm.text:
        textfile=work/'watermark.txt'
        textfile.write_text(wm.text)
        fontproc=await asyncio.create_subprocess_exec('fc-match','-f','%{file}',wm.font,stdout=asyncio.subprocess.PIPE)
        fontpath=(await fontproc.communicate())[0].decode()
        fontsize=wm.size*h/1080
        margin=wm.margin*h/1080
        vf+=f",drawtext=fontfile='{filter_path(fontpath)}':textfile='{filter_path(textfile)}':expansion=none:fontsize={fontsize}:fontcolor={wm.color}@{wm.opacity}:x={margin}+(w-tw-2*{margin})*{wm.x}:y={margin}+(h-th-2*{margin})*{wm.y}:enable='{enable}'"
    filters.append(f'[0:v:0]{vf}[base]')
    video='base'
    if image_index is not None:
        margin=wm.margin*h/1080
        filters.append(f'[{image_index}:v]scale={max(2,round(w*wm.width/2)*2)}:-2,format=rgba,colorchannelmixer=aa={wm.opacity}[wm]')
        filters.append(f"[base][wm]overlay=x={margin}+(main_w-overlay_w-2*{margin})*{wm.x}:y={margin}+(main_h-overlay_h-2*{margin})*{wm.y}:enable='{enable}':shortest=1[vout]")
        video='vout'
    audios=[]
    if meta['audio'] and not edit.audio.mute:
        if edit.audio.track >= len(meta['audio']):
            raise ValueError('The selected audio track does not exist.')
        filters.append(f'[0:a:{edit.audio.track}]volume={edit.audio.volume},atrim=duration={duration},asetpts=PTS-STARTPTS[a0]')
        audios.append('[a0]')
    if music_index is not None:
        clip_duration=edit.end-edit.start
        fade_in=min(edit.audio.fade_in,clip_duration/2)
        fade_out=min(edit.audio.fade_out,clip_duration/2)
        filters.append(f'[{music_index}:a:0]atrim=duration={duration},asetpts=PTS-STARTPTS,volume={edit.audio.music_volume},afade=t=in:d={fade_in},afade=t=out:st={clip_duration-fade_out}:d={fade_out}[music]')
        audios.append('[music]')
    if len(audios)==2:
        filters.append(''.join(audios)+'amix=inputs=2:duration=longest:normalize=0[aout]')
        audio='[aout]'
    else:
        audio=audios[0] if audios else None
    args += ['-filter_complex_threads','1','-filter_complex',';'.join(filters),'-map',f'[{video}]']
    if audio:
        args += ['-map',audio]
    preset,crf={'fast':('veryfast',23),'balanced':('medium',21),'high':('slow',18)}[edit.quality]
    args+=['-t',str(duration),'-r',str(edit.fps),'-c:v','libx264','-preset',preset,'-crf',str(crf),'-threads','3','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart','-progress','pipe:1','-nostats',str(dest)]
    try:
        await run(args,ident,duration)
        info=await probe(dest)
        name=re.sub(r'[^\w\- .]','',edit.filename).strip(' .') or 'clip'
        if preview:
            name+='-preview'
        s.execute('INSERT INTO clips VALUES (?,?,?,?,?,?,?)',(clip_id,project['id'],name+'.mp4',str(dest),json.dumps(info),time.time(),int(preview)))
        s.update_job(ident,result_id=clip_id)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    finally:
        import shutil
        shutil.rmtree(work,ignore_errors=True)
