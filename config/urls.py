"""
URL configuration for config project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/6.1/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.contrib import admin
from django.urls import path
from dashboard import (
    views,
    views_api,
    views_api_dashboard,
    views_api_gaps,
    views_api_lecture,
    views_api_lecturer,
    views_api_library,
    views_api_misc,
    views_api_profile,
    views_api_schedule,
    views_api_tasks,
)

urlpatterns = [
    path('admin/', admin.site.urls),

    # Endpoint JSON untuk halaman dashboard (jembatan ke backend FastAPI).
    path('api/document/generate/', views_api.generate_document, name='api_document_generate'),
    path('api/document/preview/', views_api.preview_document, name='api_document_preview'),
    path('api/document/save/', views_api.save_document, name='api_document_save'),
    path('api/document/download/<str:document_id>', views_api.download_document,
         name='api_document_download'),
    # Panel editing blok — daftar blok (GET), edit per blok (PATCH), dan agen
    # dokumen (POST). Satu path untuk blok; method yang membedakan aksi.
    path('api/document/blocks/<str:document_id>/', views_api.document_blocks,
         name='api_document_blocks'),
    path('api/document/agent/<str:document_id>/', views_api.document_agent,
         name='api_document_agent'),
    # Chat dokumen — satu percakapan yang bisa membuat dokumen dan
    # mengubahnya. Balasannya dialirkan sebagai Server-Sent Events.
    path('api/document/chat/', views_api.document_chat, name='api_document_chat'),

    # AI Lecturer (Dosen AI) — persona, chat, laporan mingguan, video ajar.
    path('api/lecturer/personas/', views_api_lecturer.lecturer_personas,
         name='api_lecturer_personas'),
    path('api/lecturer/persona/', views_api_lecturer.lecturer_persona_create,
         name='api_lecturer_persona_create'),
    path('api/lecturer/persona/active/', views_api_lecturer.lecturer_persona_detail,
         name='api_lecturer_persona_detail'),
    path('api/lecturer/persona/<str:persona_id>/', views_api_lecturer.lecturer_persona_update,
         name='api_lecturer_persona_update'),
    path('api/lecturer/chat/', views_api_lecturer.lecturer_chat,
         name='api_lecturer_chat'),
    # Jalur "sessions" harus didahulukan sebelum "<session_id>" — kalau tidak,
    # Django akan memperlakukan "sessions" sebagai id sesi.
    path('api/lecturer/chat/sessions/', views_api_lecturer.lecturer_chat_session_create,
         name='api_lecturer_chat_session_create'),
    path('api/lecturer/chat/<str:session_id>/', views_api_lecturer.lecturer_chat_history,
         name='api_lecturer_chat_history'),
    path('api/lecturer/chat/<str:session_id>/delete/', views_api_lecturer.lecturer_chat_session_delete,
         name='api_lecturer_chat_session_delete'),
    path('api/lecturer/reports/', views_api_lecturer.lecturer_reports,
         name='api_lecturer_reports'),
    path('api/lecturer/reports/generate/', views_api_lecturer.lecturer_reports_generate,
         name='api_lecturer_reports_generate'),
    # Jalur literal harus didahulukan sebelum "<report_id>" — kalau tidak,
    # Django akan memperlakukan "jobs" sebagai id laporan.
    path('api/lecturer/reports/jobs/', views_api_lecturer.lecturer_report_jobs,
         name='api_lecturer_report_jobs'),
    path('api/lecturer/reports/jobs/<str:job_id>/', views_api_lecturer.lecturer_report_job,
         name='api_lecturer_report_job'),
    path('api/lecturer/reports/<str:report_id>/', views_api_gaps.lecturer_report_detail,
         name='api_lecturer_report_detail'),
    path('api/lecturer/reports/<str:report_id>/export/',
         views_api_lecturer.lecturer_report_export,
         name='api_lecturer_report_export'),
    path('api/lecturer/videos/', views_api_lecturer.lecturer_videos,
         name='api_lecturer_videos'),
    path('api/lecturer/videos/generate/', views_api_lecturer.lecturer_video_create,
         name='api_lecturer_video_create'),
    path('api/lecturer/videos/<str:job_id>/', views_api_lecturer.lecturer_video_detail,
         name='api_lecturer_video_detail'),
    path('api/lecturer/videos/<str:job_id>/retry/', views_api_lecturer.lecturer_video_retry,
         name='api_lecturer_video_retry'),
    path('api/lecturer/videos/<str:job_id>/file/', views_api_lecturer.lecturer_video_file,
         name='api_lecturer_video_file'),

    # Lecture Listener — rekaman, unggah audio, transkrip, dan ringkasan.
    path('api/lecture/', views_api_lecture.lecture_list, name='api_lecture_list'),
    path('api/lecture/start/', views_api_lecture.lecture_start, name='api_lecture_start'),
    # Tiket WebSocket (FR-04). WAJIB sebelum pola ``<str:session_id>/`` —
    # kalau tidak, Django memperlakukan "ticket" sebagai id sesi.
    path('api/lecture/ticket/', views_api_lecture.lecture_ticket,
         name='api_lecture_ticket'),
    # Jalur live (FR-05): potongan PCM mentah + transkrip parsial.
    path('api/lecture/<str:session_id>/chunks/', views_api_lecture.lecture_chunk,
         name='api_lecture_chunk'),
    path('api/lecture/<str:session_id>/live/', views_api_lecture.lecture_live,
         name='api_lecture_live'),
    path('api/lecture/<str:session_id>/audio/', views_api_lecture.lecture_audio,
         name='api_lecture_audio'),
    path('api/lecture/<str:session_id>/audio/file/', views_api_lecture.lecture_audio_file,
         name='api_lecture_audio_file'),
    path('api/lecture/<str:session_id>/stop/', views_api_lecture.lecture_stop,
         name='api_lecture_stop'),
    path('api/lecture/<str:session_id>/status/', views_api_lecture.lecture_status,
         name='api_lecture_status'),
    path('api/lecture/<str:session_id>/transcript/', views_api_lecture.lecture_transcript,
         name='api_lecture_transcript'),
    path('api/lecture/<str:session_id>/summary/', views_api_lecture.lecture_summary,
         name='api_lecture_summary'),
    path('api/lecture/<str:session_id>/export/', views_api_library.lecture_export,
         name='api_lecture_export'),
    # Ekspor ke dokumen .docx sungguhan (FR-05, FR-17).
    path('api/lecture/<str:session_id>/export/doc/', views_api_lecture.lecture_export_doc,
         name='api_lecture_export_doc'),
    path('api/lecture/<str:session_id>/delete/', views_api_lecture.lecture_delete,
         name='api_lecture_delete'),

    # Perpustakaan dokumen tersimpan + OCR.
    path('api/library/documents/', views_api_library.library_documents,
         name='api_library_documents'),
    path('api/library/documents/upload/', views_api_library.library_document_upload,
         name='api_library_document_upload'),
    path('api/library/documents/<str:document_id>/', views_api_library.library_document_detail,
         name='api_library_document_detail'),
    path('api/library/documents/<str:document_id>/delete/', views_api_library.library_document_delete,
         name='api_library_document_delete'),
    path('api/library/documents/<str:document_id>/ocr/', views_api_library.library_document_ocr,
         name='api_library_document_ocr'),

    # Auto Scheduler — jadwal, bentrok, impor, dan mata kuliah.
    path('api/schedule/', views_api_schedule.schedule_collection, name='api_schedule_collection'),
    path('api/schedule/import/', views_api_schedule.schedule_import, name='api_schedule_import'),
    # Jalur literal harus didahulukan sebelum "<entry_id>" — kalau tidak,
    # Django akan memperlakukan "import" sebagai id entri.
    path('api/schedule/import/jobs/', views_api_schedule.schedule_import_jobs,
         name='api_schedule_import_jobs'),
    path('api/schedule/import/<str:job_id>/', views_api_schedule.schedule_import_job,
         name='api_schedule_import_job'),
    path('api/schedule/courses/', views_api_schedule.schedule_courses, name='api_schedule_courses'),
    # Jalur "conflicts" harusdidahulukan sebelum "<entry_id>" — kalau tidak,
    # Django akan memperlakukan "conflicts" sebagai id entri.
    path('api/schedule/conflicts/', views_api_library.schedule_conflicts,
         name='api_schedule_conflicts'),
    path('api/schedule/<str:entry_id>/', views_api_schedule.schedule_detail, name='api_schedule_detail'),

    # Reminder System — tugas, tenggat, dan pengaturan pengingat.
    # GET dan POST sengaja dipisah path-nya supaya tidak ada dua pola URL
    # yang sama — kalau digabung, hanya yang pertama yang terpakai.
    path('api/tasks/', views_api_tasks.list_tasks, name='api_task_list'),
    path('api/tasks/create/', views_api_tasks.create_task, name='api_task_create'),
    path('api/tasks/<str:task_id>/complete/', views_api_tasks.complete_task,
         name='api_task_complete'),
    path('api/tasks/<str:task_id>/reminders/', views_api_tasks.update_task_reminders,
         name='api_task_reminders'),
    path('api/tasks/<str:task_id>/edit/', views_api_tasks.update_task,
         name='api_task_update'),
    path('api/tasks/<str:task_id>/', views_api_tasks.delete_task, name='api_task_delete'),
    path('api/courses/', views_api_tasks.list_courses, name='api_course_list'),
    path('api/reminders/offsets/', views_api_tasks.list_reminder_offsets,
         name='api_reminder_offsets'),

    # RAG Assistant — unggah, indeks, dan tanya-jawab berbasis dokumen.
    path('api/rag/formats/', views_api_misc.rag_formats, name='api_rag_formats'),
    path('api/rag/documents/', views_api_misc.rag_documents, name='api_rag_documents'),
    # Jalur "search" harus DIDAHULUKAN sebelum "<document_id>" — Django
    # mencocokkan berurutan deklarasi, jadi kalau tidak, "search" akan
    # diperlakukan sebagai id dokumen.
    path('api/rag/documents/search/', views_api_misc.rag_document_search,
         name='api_rag_document_search'),
    path('api/rag/upload/', views_api_misc.rag_upload, name='api_rag_upload'),
    path('api/rag/query/', views_api_misc.rag_query, name='api_rag_query'),
    path('api/rag/documents/<str:document_id>/', views_api_misc.rag_document_detail,
         name='api_rag_document_detail'),
    path('api/rag/documents/<str:document_id>/file/', views_api_misc.rag_document_file,
         name='api_rag_document_file'),
    path('api/rag/documents/<str:document_id>/rename/', views_api_misc.rag_document_rename,
         name='api_rag_document_rename'),
    path('api/rag/documents/<str:document_id>/delete/', views_api_misc.rag_document_delete,
         name='api_rag_document_delete'),

    # Sesi percakapan RAG — riwayat yang tersimpan di backend (beda dengan
    # /api/rag/query/ yang menjawab satu pertanyaan tanpa menyimpan).
    path('api/rag/chat/sessions/', views_api_gaps.rag_chat_sessions,
         name='api_rag_chat_sessions'),
    path('api/rag/chat/sessions/create/', views_api_gaps.rag_chat_session_create,
         name='api_rag_chat_session_create'),
    path('api/rag/chat/<str:session_id>/', views_api_gaps.rag_chat_history,
         name='api_rag_chat_history'),
    path('api/rag/chat/<str:session_id>/message/', views_api_gaps.rag_chat_message,
         name='api_rag_chat_message'),
    path('api/rag/chat/<str:session_id>/delete/', views_api_gaps.rag_chat_session_delete,
         name='api_rag_chat_session_delete'),

    # Notifikasi — daftar dan tandai sudah dibaca.
    path('api/notifications/', views_api_misc.notification_list, name='api_notification_list'),
    path('api/notifications/pending/', views_api_misc.notification_pending,
         name='api_notification_pending'),
    path('api/notifications/read-all/', views_api_misc.notification_read_all,
         name='api_notification_read_all'),
    path('api/notifications/<str:notification_id>/read/', views_api_misc.notification_read,
         name='api_notification_read'),

    # Profil akun — identitas untuk sidebar & topbar.
    path('api/profile/', views_api_profile.profile, name='api_profile'),

    # Ringkasan dashboard — agregator di sisi BFF: tugas + jadwal + mata
    # kuliah dalam satu request. "Hari ini" tetap dihitung di klien (JS),
    # bukan di sini — Django pakai UTC, sedangkan data backend jam dinding.
    path('api/dashboard/summary/', views_api_dashboard.dashboard_summary,
         name='api_dashboard_summary'),

    path('', views.home, name='home'),

    # Service Worker — disajikan dari akar situs supaya scope-nya "/".
    # Kalau dilayani dari /static/, worker tidak bisa menguasai halaman
    # lain di situs ini. Lihat dashboard/views.py::service_worker.
    path('sw.js', views.service_worker, name='service_worker'),

    path('document-creator/', views.document_creator, name='document_creator'),
    path('lecture-listener/', views.lecture_listener, name='lecture_listener'),
    path('reminder-system/', views.reminder_system, name='reminder_system'),
    path('rag-assistant/', views.rag_assistant, name='rag_assistant'),
    path('ai-lecturer/', views.ai_lecturer, name='ai_lecturer'),
    path('auto-scheduler/', views.auto_scheduler, name='auto_scheduler'),
]
