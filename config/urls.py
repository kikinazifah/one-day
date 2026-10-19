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
from dashboard import views, views_api

urlpatterns = [
    path('admin/', admin.site.urls),

    # Endpoint JSON untuk halaman dashboard (jembatan ke backend FastAPI).
    path('api/document/generate/', views_api.generate_document, name='api_document_generate'),
    path('api/document/preview/', views_api.preview_document, name='api_document_preview'),
    path('api/document/save/', views_api.save_document, name='api_document_save'),
    path('api/document/download/<str:document_id>', views_api.download_document,
         name='api_document_download'),

    path('', views.home, name='home'),
    path('document-creator/', views.document_creator, name='document_creator'),
    path('lecture-listener/', views.lecture_listener, name='lecture_listener'),
    path('reminder-system/', views.reminder_system, name='reminder_system'),
    path('rag-assistant/', views.rag_assistant, name='rag_assistant'),
    path('ai-lecturer/', views.ai_lecturer, name='ai_lecturer'),
    path('auto-scheduler/', views.auto_scheduler, name='auto_scheduler'),
]
